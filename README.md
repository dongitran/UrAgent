# 🤖 UrAgent

> **Your AI-Powered Software Engineer** — An asynchronous coding agent that autonomously understands codebases, plans solutions, and executes code changes across entire repositories.

[![Fork](https://img.shields.io/badge/forked%20from-Open%20SWE-blue)](https://github.com/langchain-ai/open-swe)
[![LangGraph](https://img.shields.io/badge/built%20with-LangGraph-orange)](https://docs.langchain.com/oss/javascript/langgraph/overview)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

---

## ✨ What's New in UrAgent?

UrAgent is a **production-ready fork** of [Open SWE](https://github.com/langchain-ai/open-swe) by LangChain, enhanced with enterprise features and improved reliability:

### 🔐 Enterprise Authentication
- **Keycloak SSO** — Seamless single sign-on integration for enterprise environments
- **Auto Token Refresh** — Automatic token renewal with secure cookie handling
- **Public/Confidential Clients** — Support for both Keycloak client types

### 🧠 Advanced AI Capabilities
- **Gemini 3 Support** — Full integration with Google's latest Gemini 3 models including thought signatures
- **Multi-Provider Fallback** — Automatic failover between OpenAI, Anthropic, and Google GenAI
- **LiteLLM Gateway** — Route requests through LiteLLM for unified API access
- **Circuit Breaker Pattern** — Intelligent model switching when providers fail

### 🔄 Intelligent Loop Detection
- **Pattern Recognition** — Detects verification loops, error retries, alternating patterns, and "chanting"
- **Edit Loop Prevention** — Specifically handles `str_replace` failures (whitespace, line endings)
- **Adaptive Thresholds** — Tuned based on research from Claude Code, Gemini CLI, and Aider issues
- **Graceful Recovery** — Warns, escalates, or requests human help based on severity

### 🏗️ Multi-Sandbox Architecture
- **Provider Abstraction** — Unified interface for E2B, Daytona, and local sandboxes
- **Round-Robin Key Rotation** — Weighted distribution across multiple API keys
- **Multi-Provider Mode** — Run sandboxes across different providers simultaneously
- **Automatic Retry** — Exponential backoff for transient sandbox failures

### 🚀 Production Reliability
- **GitHub API Caching** — Intelligent caching layer for API responses
- **Retry with Backoff** — All external calls include retry logic
- **Run Cancellation** — Graceful termination with automatic commit
- **LLM Comment Generation** — Natural language PR/issue comments via AI

---

## 🎯 Core Features

| Feature | Description |
|---------|-------------|
| 📝 **Planning** | Deep understanding of complex codebases with dedicated planning step |
| 🤝 **Human in the Loop** | Send messages while running for real-time feedback |
| 🏃 **Parallel Execution** | Run multiple tasks in parallel sandbox environments |
| 🧑‍💻 **End-to-End Management** | Automatic GitHub issue and PR creation |
| 🔐 **Enterprise SSO** | Keycloak authentication for corporate environments |

---

## 🏛️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Browser                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Next.js Web Application                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │  Keycloak   │  │   GitHub    │  │     API Proxy + Cache       │  │
│  │    Auth     │  │    OAuth    │  │   (with retry & backoff)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      LangGraph API (Internal)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │   Planner   │  │ Programmer  │  │         Reviewer            │  │
│  │    Graph    │  │    Graph    │  │          Graph              │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Model Manager                                ││
│  │  • Multi-provider fallback (OpenAI → Anthropic → Google)        ││
│  │  • Circuit breaker pattern                                      ││
│  │  • Gemini 3 thought signatures                                  ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Loop Detection                               ││
│  │  • Verification loops • Error retries • Alternating patterns    ││
│  │  • Edit loops (str_replace) • Chanting detection                ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Sandbox Provider Layer                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │     E2B     │  │   Daytona   │  │          Local              │  │
│  │   Sandbox   │  │   Sandbox   │  │         (Dev Mode)          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│                                                                     │
│  • Round-robin API key rotation                                     │
│  • Multi-provider mode                                              │
│  • Automatic retry with exponential backoff                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- Yarn 3.5+
- Docker & Docker Compose

### Installation

```bash
# Clone the repository
git clone https://github.com/dongitran/UrAgent.git
cd UrAgent

# Install dependencies
yarn install

# Copy environment template
cp apps/open-swe/.env.example apps/open-swe/.env
cp apps/web/.env.example apps/web/.env
```

### Running Locally

```bash
# Start the LangGraph API (Docker)
docker compose up --build

# In another terminal, start the web app
cd apps/web && yarn dev
```

Visit `http://localhost:3000` to access the UI.

---

## ⚙️ Configuration

### Environment Variables

#### LLM Provider Configuration

```env
# Primary provider (openai, anthropic, google-genai)
LLM_PROVIDER=google-genai

# Enable multi-provider fallback
LLM_MULTI_PROVIDER_ENABLED=true

# Provider-specific models (optional)
GOOGLE_PROGRAMMER_MODEL=gemini-3-pro-preview
GOOGLE_PLANNER_MODEL=gemini-3-pro-preview
ANTHROPIC_PROGRAMMER_MODEL=claude-opus-4-5
OPENAI_PROGRAMMER_MODEL=gpt-4o

# LiteLLM Gateway (optional)
OPENAI_BASE_URL=https://your-litellm-gateway.com/v1
```

#### Sandbox Configuration

```env
# Sandbox provider: e2b, daytona, multi, local
SANDBOX_PROVIDER=daytona

# For multi-provider mode with round-robin
SANDBOX_PROVIDER=multi
DAYTONA_API_KEYS=key1,key2,key3
DAYTONA_API_KEY_WEIGHTS=3,2,1
```

#### GitHub App Configuration

```env
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."
GITHUB_APP_NAME=your-app-name
```

#### Repository Defaults

```env
DEFAULT_REPOSITORY_OWNER=your-org
DEFAULT_REPOSITORY_NAME=your-repo
DEFAULT_BRANCH=main
DEFAULT_GITHUB_INSTALLATION_ID=your-installation-id
```

### Authentication

#### Keycloak SSO (Recommended for Enterprise)

When Keycloak is configured, it becomes the **mandatory** authentication method.

```env
NEXT_PUBLIC_KEYCLOAK_URL=https://your-keycloak.example.com
NEXT_PUBLIC_KEYCLOAK_REALM=your-realm
NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=your-client-id
KEYCLOAK_REDIRECT_URI=http://localhost:3000/api/auth/keycloak/callback

# Optional: Only for confidential clients
# KEYCLOAK_CLIENT_SECRET=your-client-secret
```

**Keycloak Client Setup:**
1. Create a new client in your Keycloak realm
2. Set "Client authentication" to OFF for public clients (recommended for SPAs)
3. Add `http://localhost:3000/api/auth/keycloak/callback` to Valid Redirect URIs
4. Add `http://localhost:3000` to Web Origins

#### GitHub OAuth (Default)

When Keycloak is not configured, GitHub OAuth is used automatically.

#### Development Mode

For local development without authentication:

```env
DEFAULT_GITHUB_INSTALLATION_ID=your-installation-id
DEFAULT_GITHUB_INSTALLATION_NAME=your-github-username
```

---

## ☸️ Kubernetes Deployment

### Ingress NGINX Configuration

When deploying behind NGINX Ingress Controller, add these annotations for large authentication headers:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffer-size: "128k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
```

---

## 🔧 Advanced Features

### Loop Detection

UrAgent includes sophisticated loop detection based on research from:
- Claude Code Issue #4277 (Tool Call Loops + Content Loops)
- Gemini CLI Issue #11002 (Output comparison for false positive reduction)
- Gemini CLI Issue #5761 (str_replace_based_edit_tool specific errors)
- Cline Issue #2909 (Diff Edit Mismatch errors)
- Aider Issue #770 (Edit format errors)

**Detected Patterns:**
- `verification` — Agent keeps reading same file to verify
- `error_retry` — Agent retrying same command that errors
- `alternating` — A→B→A→B pattern
- `edit_loop` — Agent stuck trying to edit same file
- `chanting` — Model generating same content repeatedly

### Multi-Provider Fallback

The Model Manager automatically handles provider failures:

```
Primary Model (e.g., Gemini 3 Pro)
        │
        ▼ (on failure)
Circuit Breaker Opens
        │
        ▼
Fallback to Anthropic Claude
        │
        ▼ (on failure)
Fallback to OpenAI GPT-4
        │
        ▼ (after timeout)
Circuit Breaker Closes → Retry Primary
```

### Sandbox Provider Abstraction

```typescript
// Unified interface for all sandbox providers
interface ISandboxProvider {
  name: string;
  createSandbox(options: CreateSandboxOptions): Promise<ISandbox>;
  getSandbox(id: string): Promise<ISandbox | null>;
  listSandboxes(): Promise<ISandbox[]>;
}

// Supported providers
- E2B (Cloud sandboxes)
- Daytona (Self-hosted)
- Local (Development mode)
- Multi (Round-robin across providers)
```

---

## 📦 Project Structure

```
uragent/
├── apps/
│   ├── open-swe/          # LangGraph agent (Planner, Programmer, Reviewer)
│   ├── web/               # Next.js 15 + React 19 frontend
│   ├── cli/               # Command-line interface
│   └── docs/              # Documentation site
├── packages/
│   └── shared/            # Shared utilities, types, constants
├── docker-compose.yml     # Local development setup
├── langgraph.json         # LangGraph configuration
└── turbo.json             # Turborepo build orchestration
```

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the same terms as the original Open SWE project.

### Original Open SWE License

Open SWE is created by [LangChain](https://langchain.com) and is licensed under the [MIT License](https://github.com/langchain-ai/open-swe/blob/main/LICENSE).

---

## 🙏 Acknowledgments

- [LangChain](https://langchain.com) for creating Open SWE
- [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) for the agent framework
- The open-source community for inspiration on loop detection and reliability patterns

---

<p align="center">
  <strong>Built with ❤️ for developers who want AI that actually works</strong>
</p>
