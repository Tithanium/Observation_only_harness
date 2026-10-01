// Round-20 PROOF extension: the Observation_only harness autoloads every .ts
// file under this dot-folder's extensions/ dir at session start (src/extensions.js,
// pi's dist/core/extensions/loader.js contract). The DEFAULT EXPORT is a factory
// called with the harness's extension API — api.registerCommand(name, options)
// adds a slash command end-to-end: /help + the slash proposal list it,
// handleCommand dispatches it, the session runs its handler(args, ctx) and
// prints the returned string. TypeScript runs natively (Node >= 22.19 strips
// types — erasable syntax only, no enums/namespaces, no imports of packages the
// harness does not bundle).
export default function (pi: {
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: unknown) => string },
  ) => void;
}) {
  pi.registerCommand("hello", {
    description: "the round-20 proof command — says hello from the extensions dir",
    handler: (args: string, ctx: unknown) => `hello from the extensions dir — args: ${args || "(none)"}`,
  });
}
