import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

let ghostTextData: { [key: string]: { title: string; filePath: string } } = {};
let decorationType: vscode.TextEditorDecorationType | null = null;
const outputChannel = vscode.window.createOutputChannel("OWASP MAS Helper");

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
        ['markdown'], // Supports text & markdown files
        {
            provideCompletionItems(document, position) {
                const linePrefix = document.lineAt(position).text.substring(0, position.character);
                if (!linePrefix.endsWith("@")) {
                    return undefined;
                }

                return Object.keys(ghostTextData).map(key => {
                    const title = ghostTextData[key].title || "Unknown Title";
                    const item = new vscode.CompletionItem(`${key} - ${title}`, vscode.CompletionItemKind.Reference);
                    item.insertText = `${key}`; // Insert only @ID when selected
                    return item;
                });
            }
        },
        "@" // Trigger autocomplete when typing "@"
    );

    context.subscriptions.push(provider);

    // Update the Quick Open Dialog
    vscode.commands.registerCommand('extension.searchMastgFiles', searchMastgItems()),
        vscode.commands.registerCommand('extension.searchTools', searchMastgItems('TOOL')),
        vscode.commands.registerCommand('extension.searchTechniques', searchMastgItems('TECH')),
        vscode.commands.registerCommand('extension.searchTests', searchMastgItems('TEST')),
        vscode.commands.registerCommand('extension.searchApps', searchMastgItems('APP')),
        vscode.commands.registerCommand('extension.searchDemos', searchMastgItems('DEMO'))
    vscode.commands.registerCommand('extension.searchMASWE', searchMastgItems('MASWE'))
}

function searchMastgItems(typeFilter?: string) {
    return async () => {
        const sortedEntries = Object.entries(ghostTextData)
            .map(([key, value]) => {
                const match = key.match(/^(MA(?:STG|SWE))-(?:([A-Z]+)-)?(\d{4})$/);
                if (!match) return null;

                const [, prefix, maybeSubtype, num] = match;

                // Determine the type based on the prefix
                const type = prefix === "MASTG" ? maybeSubtype : prefix;
                return {
                    key,
                    title: value.title || value,
                    filePath: value.filePath || '',
                    type,
                    num: Number(num)
                };
            })
            .filter(entry => entry !== null)
            .filter(entry => !typeFilter || entry.type === typeFilter)
            .sort((a, b) => {
                if (a.type !== b.type) return a.type.localeCompare(b.type);
                return a.num - b.num;
            });

        const items: vscode.QuickPickItem[] = [];
        let lastType = '';

        for (const entry of sortedEntries) {
            if (!typeFilter && entry.type !== lastType) {
                items.push({
                    kind: vscode.QuickPickItemKind.Separator,
                    label: entry.type
                } as any);
                lastType = entry.type;
            }

            items.push({
                label: `${entry.key} ${entry.title} (${entry.key})`,
                description: entry.filePath
            });
        }

        const picked = await vscode.window.showQuickPick(items, {
            matchOnDescription: true,
            placeHolder: typeFilter
                ? `Search only ${typeFilter} items`
                : 'Search MAS files by title or ID'
        });

        if (picked && picked.kind !== vscode.QuickPickItemKind.Separator) {
            const doc = await vscode.workspace.openTextDocument(picked.description!);
            vscode.window.showTextDocument(doc);
        }
    };
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

    let updatedData: { [key: string]: { title: string; filePath: string } } = {};
    for (const file of markdownFiles) {
        const filePath = file;
        const content = fs.readFileSync(filePath, 'utf8');
        const title = extractTitleFromYAML(content);

        if (title) {
            const fileKey = path.basename(file, '.md'); // Extract MASTG-TECH-XXXX from filename
            updatedData[fileKey] = { title, filePath };
            outputChannel.appendLine(`${fileKey} -> ${title}`)
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
    outputChannel.appendLine(`Using base dir ${rootPath}`)
    return sort_unique(findMarkdownFilesRecursive(rootPath));
}

function findMarkdownFilesRecursive(dir: string): string[] {
    let results: string[] = [];

    try {
        const files = fs.readdirSync(dir, { withFileTypes: true });

        for (const file of files) {
            if (file.name == "docs" || file.name.startsWith(".")) {
                outputChannel.appendLine(file.name + " is ignored");
                continue
            }
            const filePath = path.join(dir, file.name);
            outputChannel.appendLine(`Checking file: ${filePath}`);
            if (file.isDirectory()) {
                results = results.concat(findMarkdownFilesRecursive(filePath));
            } else if (/^MASTG-(TOOL|TECH|TEST|DEMO|APP|BEST)-\d{4}\.md$|^MASWE-\d{4}\.md$/.test(file.name)) {
                outputChannel.appendLine(`Identified markdown file: ${filePath}`)
                results.push(filePath);
            }
        }
    }
    catch (err) {
        outputChannel.appendLine(`Error reading directory ${dir}`)
    }

    return results;
}

function sort_unique(arr: string[]): string[] {
    if (arr.length === 0) return arr;

    // Sort numerically by converting strings to numbers
    arr = arr.sort((a, b) => Number(a) - Number(b));

    const ret: string[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i - 1] !== arr[i]) {
            ret.push(arr[i]);
        }
    }

    return ret;
}

function extractTitleFromYAML(content: string): string | null {
    const yamlRegex = /^---\s*\n([\s\S]*?)\n---/;
    const match = content.match(yamlRegex);
    if (match) {
        try {
            const yamlContent = yaml.load(match[1]) as { title?: string };
            return yamlContent?.title || null;
        } catch (e) {
            outputChannel.appendLine("Error parsing YAML: " + e)
        }
    }
    else {
        outputChannel.appendLine("No title: " + content)
    }
    return null;
}

function triggerUpdateDecorations(editor: vscode.TextEditor) {
    const doc = editor.document;

    // Only proceed if the file is Markdown
    if (doc.languageId !== 'markdown') return;

    const regex = /(@?(MASTG-(TOOL|TECH|TEST|DEMO|APP|BEST)-\d{4}|MASWE-\d{4}))/g;
    const text = doc.getText();
    const decorations: vscode.DecorationOptions[] = [];

    let match;
    while ((match = regex.exec(text)) !== null) {
        const key = match[2];
        const ghostText = ghostTextData[key].title || "Unknown Reference";

        const startPos = doc.positionAt(match.index);
        const endPos = doc.positionAt(match.index + match[1].length);

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

export function deactivate() { }
