import type { ToolCardData } from "./ToolCard.js";

export interface ToolOutputRendererProps {
  readonly tool: ToolCardData;
}

/** Renders the structured output view appropriate for each supported tool. */
export function ToolOutputRenderer({ tool }: ToolOutputRendererProps) {
  switch (tool.name) {
    case "bash":
      return <BashOutput tool={tool} />;
    case "read":
      return <PathAndOutput label="Read file" tool={tool} />;
    case "edit":
      return <DiffOutput output={tool.output} />;
    case "write":
      return <PathAndOutput label="Written file" tool={tool} />;
    case "grep":
      return <SearchResults output={tool.output} />;
    case "find":
    case "ls":
      return <FileList output={tool.output} />;
    default:
      return <UnknownOutput tool={tool} />;
  }
}

function BashOutput({ tool }: ToolOutputRendererProps) {
  return (
    <div>
      <p><strong>Command:</strong> {String(tool.args.command ?? "")}</p>
      <pre className="terminal-output">{tool.output}</pre>
    </div>
  );
}

function PathAndOutput({ label, tool }: { readonly label: string; readonly tool: ToolCardData }) {
  const filePath = String(tool.args.path ?? tool.args.file ?? "unknown");
  return (
    <div>
      <p><strong>{label}:</strong> <code>{filePath}</code></p>
      <pre><code>{tool.output}</code></pre>
    </div>
  );
}

function DiffOutput({ output }: { readonly output: string }) {
  return (
    <pre className="diff-output">
      {output.split("\n").map((line, index) => (
        <span key={index} className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context"}>{line}{"\n"}</span>
      ))}
    </pre>
  );
}

function SearchResults({ output }: { readonly output: string }) {
  const lines = output.split("\n").filter(Boolean);
  return <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>;
}

function FileList({ output }: { readonly output: string }) {
  const files = output.split("\n").filter(Boolean);
  return <ul>{files.map((file, index) => <li key={index}><code>{file}</code></li>)}</ul>;
}

function UnknownOutput({ tool }: ToolOutputRendererProps) {
  return (
    <div>
      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
      <pre>{tool.output}</pre>
    </div>
  );
}
