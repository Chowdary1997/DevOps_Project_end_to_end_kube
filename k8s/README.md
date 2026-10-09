# Kubernetes deployment

Traffic path: Ingress -> `frontend` Service (nginx, :80) -> `backend` Service (Express, :3000) -> `postgres` Service (:5432).
The frontend calls `/api/...` on its own origin, and nginx forwards those calls to the backend, so the browser never needs a backend URL.

## 1. Build and push the images
```
REGISTRY=registry.example.com/coming-soon
TAG=1.0.0
docker build -t $REGISTRY/backend:$TAG  backend
docker build -t $REGISTRY/frontend:$TAG frontend
docker build -t $REGISTRY/db:$TAG       database
docker push $REGISTRY/backend:$TAG && docker push $REGISTRY/frontend:$TAG && docker push $REGISTRY/db:$TAG
```
Update `images:` in `kustomization.yaml` to match, or run `kustomize edit set image` in CI.

## 2. Edit the configuration
Set `PUBLIC_BASE_URL`, `SMTP_*`, `MAIL_FROM`, `LAUNCH_AT` in `configmap.yaml`, and the host in `ingress.yaml`.

## 3. Create the namespace and secrets (never commit these)
```
kubectl apply -f k8s/namespace.yaml
kubectl -n coming-soon create secret generic coming-soon-secrets \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=IP_HASH_SALT="$(openssl rand -hex 32)" \
  --from-literal=ADMIN_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SMTP_USER="your-smtp-user" \
  --from-literal=SMTP_PASS="your-smtp-password"
```
`IP_HASH_SALT` must stay the same across redeploys, or IP hashes stop matching. Keep the ADMIN_TOKEN somewhere safe. In production, sync these from a secrets manager with External Secrets Operator or Sealed Secrets.

## 4. Deploy
```
kubectl apply -k k8s/
kubectl -n coming-soon rollout status statefulset/postgres
kubectl -n coming-soon rollout status deploy/backend
kubectl -n coming-soon rollout status deploy/frontend
```

## 5. Verify the chain
```
kubectl -n coming-soon port-forward svc/frontend 8080:80
curl -s http://localhost:8080/api/health        # frontend -> backend -> database
curl -s http://localhost:8080/api/config
```
Then open the Ingress host in a browser.

## Notes
- Migrations run when the backend starts. The advisory lock makes two replicas starting together safe.
- The database init script (`01-harden.sh`) runs only on an empty volume.
- Probes come from the kubelet, so `/api/health` is exempt from rate limiting.
- If your CNI blocks kubelet probes under NetworkPolicy, allow the node CIDR for the probed ports.
- Backend egress (SMTP) is unrestricted here. Tighten it with an egress policy to your provider's IPs if your cluster requires it.
