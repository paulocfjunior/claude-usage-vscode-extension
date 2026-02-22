import * as vscode from "vscode";

const SECTION = "claudeUsage";

export function getFilePath(): string {
  return vscode.workspace
    .getConfiguration(SECTION)
    .get<string>("filePath", "~/.cache/claude-o-meter.json");
}

export function getUpdateIntervalMs(): number {
  const seconds = vscode.workspace
    .getConfiguration(SECTION)
    .get<number>("updateIntervalSeconds", 60);
  return Math.max(seconds, 10) * 1000;
}
