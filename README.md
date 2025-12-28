# UrAgent

An asynchronous coding agent for automated software development, forked from [Open SWE](https://github.com/langchain-ai/open-swe) by LangChain.

## About

UrAgent is built on top of Open SWE, an open-source cloud-based asynchronous coding agent built with [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It autonomously understands codebases, plans solutions, and executes code changes across entire repositories—from initial planning to opening pull requests.

## Features

- 📝 **Planning**: Dedicated planning step for deep understanding of complex codebases and nuanced tasks
- 🤝 **Human in the loop**: Send messages while running for real-time feedback
- 🏃 **Parallel Execution**: Run multiple tasks in parallel in sandbox environments
- 🧑‍💻 **End to end task management**: Automatic GitHub issue and PR creation
- 🔐 **Keycloak SSO**: Enterprise single sign-on authentication support

## Authentication

UrAgent supports multiple authentication methods:

### Keycloak SSO (Recommended for Enterprise)

When Keycloak is configured, it becomes the **mandatory** authentication method. Users must login via Keycloak to access the application.

```env
# Keycloak Configuration
NEXT_PUBLIC_KEYCLOAK_URL=https://your-keycloak.example.com
NEXT_PUBLIC_KEYCLOAK_REALM=your-realm
NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=your-client-id
KEYCLOAK_REDIRECT_URI=http://localhost:3000/api/auth/keycloak/callback

# Optional: Only needed for confidential clients (Client authentication enabled in Keycloak)
# KEYCLOAK_CLIENT_SECRET=your-client-secret
```

**Keycloak Client Setup:**
1. Create a new client in your Keycloak realm
2. Set "Client authentication" to OFF for public clients (recommended for SPAs)
3. Add `http://localhost:3000/api/auth/keycloak/callback` to Valid Redirect URIs
4. Add `http://localhost:3000` to Web Origins

### GitHub OAuth (Default)

When Keycloak is not configured, GitHub OAuth is used for authentication.

### Development Mode

For local development without authentication, configure default GitHub installation:

```env
DEFAULT_GITHUB_INSTALLATION_ID=your-installation-id
DEFAULT_GITHUB_INSTALLATION_NAME=your-github-username
```

## Configuration

### Repository Configuration

```env
DEFAULT_REPOSITORY_OWNER=your-org
DEFAULT_REPOSITORY_NAME=your-repo
DEFAULT_BRANCH=main
DEFAULT_GITHUB_INSTALLATION_ID=your-installation-id
```

### GitHub App Configuration

```env
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."
GITHUB_APP_NAME=your-app-name
```

## Development

```bash
# Install dependencies
yarn install

# Start the API (Docker)
docker compose up --build

# Start the web app
cd apps/web && yarn dev
```

## Kubernetes Deployment

### Ingress NGINX Configuration

When deploying the web app behind NGINX Ingress Controller, add these annotations to handle large headers (required for authentication cookies):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffer-size: "128k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Browser   │────▶│  Next.js Web │────▶│  LangGraph API  │
│             │     │   (Auth)     │     │   (Internal)    │
└─────────────┘     └──────────────┘     └─────────────────┘
       │                   │
       │                   │
       ▼                   ▼
┌─────────────┐     ┌──────────────┐
│  Keycloak   │     │   GitHub     │
│    SSO      │     │    App       │
└─────────────┘     └──────────────┘
```

- **Browser**: User interface
- **Next.js Web**: Handles authentication (Keycloak/GitHub), proxies requests to LangGraph
- **LangGraph API**: Internal API, no authentication required (accessed only from Next.js server)
- **Keycloak**: Enterprise SSO provider
- **GitHub App**: Repository access and operations

## License

This project is licensed under the same terms as the original Open SWE project.

### Original Open SWE License

Open SWE is created by [LangChain](https://langchain.com) and is licensed under the [MIT License](https://github.com/langchain-ai/open-swe/blob/main/LICENSE).

## Acknowledgments

- [LangChain](https://langchain.com) for creating Open SWE
- [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) for the agent framework
