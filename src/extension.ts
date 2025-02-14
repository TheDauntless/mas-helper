import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

let ghostTextData: { [key: string]: string } = {};
let decorationType: vscode.TextEditorDecorationType | null = null;

export function activate(context: vscode.ExtensionContext) {
    loadReferences();

    let activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        triggerUpdateDecorations(activeEditor);
    }

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            triggerUpdateDecorations(editor);
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
            triggerUpdateDecorations(vscode.window.activeTextEditor);
        }
    }, null, context.subscriptions);

    let updateCommand = vscode.commands.registerCommand('extension.updateReferences', updateReferences);
    context.subscriptions.push(updateCommand);

    let provider = vscode.languages.registerCompletionItemProvider(
        ['plaintext', 'markdown'], // Supports text & markdown files
        {
            provideCompletionItems(document, position) {
                const linePrefix = document.lineAt(position).text.substring(0, position.character);
                if (!linePrefix.endsWith("@")) {
                    return undefined;
                }

                return Object.keys(ghostTextData).map(key => {
                    const title = ghostTextData[key] || "Unknown Title";
                    const item = new vscode.CompletionItem(`${key} - ${title}`, vscode.CompletionItemKind.Reference);
                    item.insertText = `${key}`; // Insert only @ID when selected
                    return item;
                });
            }
        },
        "@" // Trigger autocomplete when typing "@"
    );

    context.subscriptions.push(provider);
}

function loadReferences() {
    const dataPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'references.json');

    if (fs.existsSync(dataPath)) {
        ghostTextData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    }
}

async function updateReferences() {
    if (!vscode.workspace.workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder found.");
        return;
    }
    const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const markdownFiles = getAllMarkdownFiles();

    let updatedData: { [key: string]: string } = {};
    for (const file of markdownFiles) {
        const filePath = file;
        const content = fs.readFileSync(filePath, 'utf8');
        const title = extractTitleFromYAML(content);

        if (title) {
            const fileKey = path.basename(file, '.md'); // Extract MASTG-TECH-XXXX from filename
            updatedData[fileKey] = title;
        }
    }

    if (Object.keys(updatedData).length > 0) {
        const dataPath = path.join(workspacePath, 'references.json');
        fs.writeFileSync(dataPath, JSON.stringify(updatedData, null, 4));
        vscode.window.showInformationMessage("References updated successfully!");
    } else {
        vscode.window.showWarningMessage("No valid YAML titles found in Markdown files.");
    }

    ghostTextData = updatedData;

    vscode.window.visibleTextEditors.forEach(editor => {
        triggerUpdateDecorations(editor);
    });

    vscode.window.showInformationMessage("Reference data updated and applied.");
}

function getWorkspaceRoot(): string | null {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else if (vscode.window.activeTextEditor) {
        return path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    return null;
}

function getAllMarkdownFiles(): string[] {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) {
        vscode.window.showErrorMessage("No workspace or folder found.");
        return [];
    }

    return findMarkdownFilesRecursive(rootPath);
}

function findMarkdownFilesRecursive(dir: string): string[] {
    let results: string[] = [];

    try {
        const files = fs.readdirSync(dir, { withFileTypes: true });

        for (const file of files) {
            const filePath = path.join(dir, file.name);

            if (file.isDirectory()) {
                results = results.concat(findMarkdownFilesRecursive(filePath));
            } else if (/^MASTG-(TOOL|TECH|TEST)-\d{4}\.md$/.test(file.name)) {
                results.push(filePath);
            }
        }
    } catch (err) {
        console.error(`Error reading directory ${dir}:`, err);
    }

    return results;
}

function extractTitleFromYAML(content: string): string | null {
    const yamlRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(yamlRegex);
    if (match) {
        try {
            const yamlContent = yaml.load(match[1]) as { title?: string };
            return yamlContent?.title || null;
        } catch (e) {
            console.error("Error parsing YAML:", e);
        }
    }
    return null;
}

function triggerUpdateDecorations(editor: vscode.TextEditor) {
    const regex = /(@?(MASTG-(TOOL|TECH|TEST)-\d{4}))/g;
    const text = editor.document.getText();
    const decorations: vscode.DecorationOptions[] = [];

    let match;
    while ((match = regex.exec(text)) !== null) {
        const key = match[2];
        const ghostText = ghostTextData[key] || "Unknown Reference";

        const startPos = editor.document.positionAt(match.index);
        const endPos = editor.document.positionAt(match.index + match[1].length);

        const decoration = {
            range: new vscode.Range(startPos, endPos),
            renderOptions: {
                after: {
                    contentText: ` [${ghostText}]`,
                    color: "gray",
                    fontStyle: "italic"
                }
            }
        };
        decorations.push(decoration);
    }

    if (decorationType) {
        editor.setDecorations(decorationType, []);
    }

    decorationType = vscode.window.createTextEditorDecorationType({});
    editor.setDecorations(decorationType, decorations);
}

export function deactivate() {}
