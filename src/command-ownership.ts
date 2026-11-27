/** Native commands that require the terminal UI or change machine-wide state. */
export const terminalOnlyCommands = [
  "scoped-models", "favorite-models", "task-kill", "login", "logout", "trust", "export", "import",
  "share", "reload", "keybindings", "changelog", "quit", "exit", "bug", "debug",
] as const;

/** These names use Web views or a dedicated API action instead of native prompt dispatch. */
export const dedicatedCommands = [
  "dag", "tasks", "todo", "reasoning", "efforts", "compact", "settings", "setting",
] as const;
