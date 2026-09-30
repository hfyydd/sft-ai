import { skillStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('Skills');

/**
 * Builds the system-prompt fragment for all enabled 'always' skills.
 * Returns an empty string when no skill is active so prompts stay unchanged.
 *
 * Skill text is user-configured (extension owner), i.e. trusted instructions —
 * unlike page content, which is wrapped as untrusted data elsewhere.
 */
export async function getSkillsSystemInstructions(): Promise<string> {
  try {
    const skills = (await skillStore.getSkills()).filter(s => s.enabled && s.mode === 'always');
    if (skills.length === 0) {
      return '';
    }
    const sections = skills.map(s => `### ${s.name}\n${s.prompt.trim()}`);
    return [
      '## User-configured skills',
      'The extension user has configured the following skills. Apply them to this task whenever they are relevant:',
      ...sections,
    ].join('\n\n');
  } catch (error) {
    logger.error('Failed to load skills, continuing without them:', error);
    return '';
  }
}
