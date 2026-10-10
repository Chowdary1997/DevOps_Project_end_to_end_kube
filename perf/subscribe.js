// Load test: read-heavy traffic plus subscription writes against the backend directly.
// Each virtual user presents its own client IP so per-IP rate limits do not mask the load.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 25 },
    { duration: '2m', target: 50 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:config}': ['p(95)<150'],
    'http_req_duration{name:subscribe}': ['p(95)<500'],
  },
};

const BASE = __ENV.BASE_URL || 'http://backend:3000';

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': `10.${__VU % 250}.${__ITER % 250}.1`,
  };

  const config = http.get(`${BASE}/api/config`, { headers, tags: { name: 'config' } });
  check(config, { 'config is 200': (r) => r.status === 200 });

  const email = `load-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const sub = http.post(`${BASE}/api/subscribe`, JSON.stringify({ email, consent: true }), {
    headers,
    tags: { name: 'subscribe' },
  });
  check(sub, { 'subscribe is accepted': (r) => r.status === 202 });

  sleep(1);
}
