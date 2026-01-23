export const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const CLIENT_SECRET = "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";

// Endpoint Strategy: Sandbox (Daily) -> Autopush -> Prod
export const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com", // 优先使用 Sandbox (更新更快，配额可能独立)
  "https://autopush-cloudcode-pa.sandbox.googleapis.com", // 备用 Sandbox
  "https://cloudcode-pa.googleapis.com", // 生产环境 (兜底)
];

// 默认端点 (Daily)
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINTS[0];

// Masquerading Headers (Impersonate IDE)
export const COMMON_HEADERS = {
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata":
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

// System Instructions
export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

export const CLAUDE_TOOL_SYSTEM_INSTRUCTION = `
# Tool Usage
You have access to a set of tools. You must use them to answer the user's question.
If the user asks to perform an action that you can do with a tool, you MUST use the tool.
`;
