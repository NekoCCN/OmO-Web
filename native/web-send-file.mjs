export default function (pi) {
  pi.registerTool({
    name: "send_file",
    label: "Send file",
    description: "Send a workspace file as a downloadable attachment when the user asks for a file, rather than returning a host path.",
    promptSnippet: "Send a workspace file to the Web conversation as a downloadable attachment",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path to a file in this conversation's workspace" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      const response = await fetch(process.env.OMO_WEB_SEND_FILE_BRIDGE, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OMO_WEB_SEND_FILE_SECRET}` },
        body: JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
          cwd: ctx.cwd, path: params.path }),
      });
      if (response.status === 507) throw new Error("The configured OmO Web attachment storage quota would be exceeded.");
      if (!response.ok) throw new Error("The file could not be sent from this workspace.");
      const receipt = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: {} };
    },
  });
}
