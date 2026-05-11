import { useMemo, useState } from "react";

export interface ProjectFile { readonly path: string; readonly kind: "file" | "directory"; readonly content?: string; }
export interface GitFile { readonly path: string; readonly status: string; readonly diff?: string; }

export interface ProjectExplorerProps {
  readonly files: readonly ProjectFile[];
  readonly gitFiles: readonly GitFile[];
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly onCreateWorktree: (name: string) => void;
}

export function ProjectExplorer(props: ProjectExplorerProps) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [worktreeName, setWorktreeName] = useState("session-worktree");
  const visibleFiles = useMemo(() => props.files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())), [props.files, query]);
  const selected = selectedPath ? props.files.find((file) => file.path === selectedPath) : undefined;

  return (
    <section aria-label="Project explorer">
      <h2>Files</h2>
      <input aria-label="Search files" value={query} onChange={(event) => setQuery(event.target.value)} />
      <ul aria-label="Project files">
        {visibleFiles.map((file) => <li key={file.path}><button type="button" onClick={() => setSelectedPath(file.path)}>{file.path}</button></li>)}
      </ul>

      {selected ? (
        <article aria-label="File viewer">
          <h3>{selected.path}</h3>
          {selected.path.endsWith(".md") ? <div aria-label="Markdown preview">{selected.content}</div> : null}
          {selected.path.match(/\.(png|jpg|jpeg|gif)$/) ? <p>Image preview: {selected.path}</p> : null}
          <pre><code>{selected.content}</code></pre>
        </article>
      ) : null}

      <section aria-label="Session file tracking">
        <h3>Tracked files</h3>
        <p>Read: {props.readFiles.join(", ")}</p>
        <p>Modified: {props.modifiedFiles.join(", ")}</p>
      </section>

      <section aria-label="Git status">
        <h3>Git</h3>
        {props.gitFiles.map((file) => (
          <article key={file.path}>
            <strong>{file.status}</strong> {file.path}
            {file.diff ? <pre className="diff-output">{file.diff}</pre> : null}
          </article>
        ))}
      </section>

      <section aria-label="Worktree controls">
        <input aria-label="Worktree name" value={worktreeName} onChange={(event) => setWorktreeName(event.target.value)} />
        <button type="button" onClick={() => props.onCreateWorktree(worktreeName)}>Create worktree</button>
      </section>
    </section>
  );
}
