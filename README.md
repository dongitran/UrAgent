# UrAgent

An asynchronous coding agent for automated software development, forked from [Open SWE](https://github.com/langchain-ai/open-swe) by LangChain.

## About

UrAgent is built on top of Open SWE, an open-source cloud-based asynchronous coding agent built with [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It autonomously understands codebases, plans solutions, and executes code changes across entire repositories—from initial planning to opening pull requests.

## Features

- 📝 **Planning**: Dedicated planning step for deep understanding of complex codebases and nuanced tasks
- 🤝 **Human in the loop**: Send messages while running for real-time feedback
- 🏃 **Parallel Execution**: Run multiple tasks in parallel in sandbox environments
- 🧑‍💻 **End to end task management**: Automatic GitHub issue and PR creation

## Configuration

UrAgent uses environment variables for default repository configuration:

```env
DEFAULT_REPOSITORY_OWNER=your-org
DEFAULT_REPOSITORY_NAME=your-repo
DEFAULT_BRANCH=main
DEFAULT_GITHUB_INSTALLATION_ID=your-installation-id
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

## License

This project is licensed under the same terms as the original Open SWE project.

### Original Open SWE License

Open SWE is created by [LangChain](https://langchain.com) and is licensed under the [MIT License](https://github.com/langchain-ai/open-swe/blob/main/LICENSE).

## Acknowledgments

- [LangChain](https://langchain.com) for creating Open SWE
- [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) for the agent framework
