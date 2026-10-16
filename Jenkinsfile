// Required Jenkins plugins: Pipeline, Docker Pipeline, JUnit, Credentials Binding, Timestamper.
// Agent needs Docker with the Compose v2 plugin.
pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    REGISTRY  = 'registry.example.com/coming-soon'
    IMAGE_TAG = "${BUILD_NUMBER}"
    NODE_IMG  = 'node:22-bookworm-slim'
    COMPOSE   = 'docker compose -p coming-soon-ci -f docker-compose.test.yml'
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Lint, audit and unit tests') {
      steps {
        sh 'docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORKSPACE/backend:/app" -w /app "$NODE_IMG" sh -c "npm ci --no-audit --no-fund && npm run lint && npm audit --omit=dev --audit-level=high && npm run test:unit"'
      }
    }

    stage('Build images') {
      steps {
        sh 'docker build -t "$REGISTRY/backend:$IMAGE_TAG" backend'
        sh 'docker build -t "$REGISTRY/frontend:$IMAGE_TAG" frontend'
        sh 'docker build -t "$REGISTRY/db:$IMAGE_TAG" database'
      }
    }

    stage('Image security scan') {
      steps {
        sh 'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.56.2 image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$REGISTRY/backend:$IMAGE_TAG"'
        sh 'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.56.2 image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$REGISTRY/frontend:$IMAGE_TAG"'
        sh 'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.56.2 image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$REGISTRY/db:$IMAGE_TAG"'
      }
    }

    stage('Start test stack') {
      steps {
        sh '$COMPOSE --profile test up -d --build --wait db mailpit backend frontend'
      }
    }

    stage('API, integration and regression tests') {
      steps {
        sh '$COMPOSE --profile test run --rm api-tests'
      }
    }

    stage('End-to-end browser tests') {
      steps {
        sh '$COMPOSE --profile e2e run --rm e2e'
      }
    }

    stage('Load tests') {
      when { anyOf { branch 'main'; triggeredBy 'TimerTrigger' } }
      steps {
        sh '$COMPOSE --profile perf run --rm k6'
      }
    }

    stage('Publish images') {
      when { branch 'main' }
      steps {
        withCredentials([usernamePassword(credentialsId: 'registry-creds', usernameVariable: 'REG_USER', passwordVariable: 'REG_PASS')]) {
          sh 'echo "$REG_PASS" | docker login "${REGISTRY%%/*}" -u "$REG_USER" --password-stdin'
          sh 'for s in backend frontend db; do docker push "$REGISTRY/$s:$IMAGE_TAG"; done'
        }
      }
    }
  }

  post {
    always {
      junit allowEmptyResults: true, testResults: 'backend/reports/*.xml, reports/*.xml'
      archiveArtifacts artifacts: 'backend/reports/**, reports/**', allowEmptyArchive: true
      sh '$COMPOSE --profile test --profile e2e --profile perf logs --no-color > compose.log 2>&1 || true'
      archiveArtifacts artifacts: 'compose.log', allowEmptyArchive: true
      sh '$COMPOSE --profile test --profile e2e --profile perf down -v --remove-orphans || true'
      sh 'docker run --rm -v "$WORKSPACE:/w" alpine sh -c "chown -R $(id -u):$(id -g) /w" || true'
    }
  }
}
