import type { Translator } from '@shared/i18n';

/**
 * Localized display label for a raw agent tool name (e.g. "Bash" → "Run
 * command", "TodoWrite" → "Update todos"). Shared by the chat transcript
 * (`presentTool`) and the monitor card so both surfaces show the same
 * translated tool name instead of the internal identifier.
 */
export function toolLabel(name: string, t: Translator): string {
  switch (name) {
    case 'Bash':
      return t('chat.tool.bash');
    case 'Edit':
    case 'MultiEdit':
      return t('chat.tool.edit');
    case 'Write':
      return t('chat.tool.write');
    case 'Read':
      return t('chat.tool.read');
    case 'Glob':
      return t('chat.tool.glob');
    case 'Grep':
      return t('chat.tool.grep');
    case 'WebFetch':
      return t('chat.tool.fetch');
    case 'WebSearch':
      return t('chat.tool.search');
    case 'Task':
      return t('chat.tool.subagent');
    case 'TodoWrite':
      return t('chat.tool.todos');
    case 'NotebookEdit':
      return t('chat.tool.notebook');
    default:
      return name || t('chat.tool.generic');
  }
}
