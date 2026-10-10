FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
