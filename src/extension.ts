import * as vscode from "vscode";
import { StatusBarManager } from "./statusBar";

let manager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new StatusBarManager();
  manager.activate(context);
}

export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}
