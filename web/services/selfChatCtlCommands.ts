import commands from "./selfChatCtlCommands.json";

// The CLI's real Clap parser tests these same argument vectors. Keep shell
// quoting at this presentation boundary; never execute the prompt examples.
function render(args: string[]): string {
  return ['"$CC_PANES_CTL"', ...args.map((arg) => arg === "<args>" ? "'<args>'" : arg)].join(" ");
}

export const SELF_CHAT_CTL_SCHEMA = render(commands.schema);
export const SELF_CHAT_CTL_CALL = render(commands.call);
