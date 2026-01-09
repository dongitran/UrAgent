export const DEFAULT_EXCLUDED_PATTERNS = [
  "node_modules",
  "langgraph_api",
  // NOTE: .env files are NOT excluded because this is a private repository
  // and secrets can be committed directly
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  ".nyc_output",
  "logs",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  "*.backup",
  ".skills",
];
