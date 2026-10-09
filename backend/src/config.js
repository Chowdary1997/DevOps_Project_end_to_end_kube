'use strict';

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};
const flag = (value, fallback) => (value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value));
const required = (name) => {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
const secret = (name) => {
  const value = required(name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
};

module.exports = Object.freeze({
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', 3000)),
  baseUrl: required('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: flag(env('DATABASE_SSL'), false),
  trustProxy: Number(env('TRUST_PROXY', 0)),
  doubleOptIn: flag(env('DOUBLE_OPT_IN'), true),
  launchAt: env('LAUNCH_AT'),
  policyVersion: env('PRIVACY_POLICY_VERSION', '2026-10-01'),
  ipHashSalt: secret('IP_HASH_SALT'),
  adminToken: secret('ADMIN_TOKEN'),
  webhookSecret: secret('WEBHOOK_SECRET'),
  mail: {
    host: required('SMTP_HOST'),
    port: Number(env('SMTP_PORT', 587)),
    secure: flag(env('SMTP_SECURE'), false),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: required('MAIL_FROM'),
  },
});
