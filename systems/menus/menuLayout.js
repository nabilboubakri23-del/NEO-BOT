/**
 * Menu categories, in display order. A command appears in a category when its
 * `category` field matches the key or one of the aliases. Categories without
 * commands are shown as "Coming soon", so the menu grows on its own as new
 * command files are added — no menu code to edit.
 */
export const CATEGORIES = Object.freeze([
    { key: 'ai', title: 'AI CENTER', description: 'Chat AI, translator, text assistant.', section: 'MAIN SYSTEMS', aliases: ['ai_center'] },
    { key: 'tools', title: 'SMART TOOLS', description: 'Calculator, QR, passwords and more.', section: 'MAIN SYSTEMS', aliases: ['smart_tools', 'tool', 'utility'] },
    { key: 'media', title: 'MEDIA LAB', description: 'Image, video and audio tools.', section: 'MAIN SYSTEMS', aliases: ['media_lab'] },
    { key: 'download', title: 'DOWNLOADS', description: 'Videos, music, apps and files.', section: 'MAIN SYSTEMS', aliases: ['downloads', 'dl'] },
    { key: 'knowledge', title: 'KNOWLEDGE', description: 'Wiki, dictionary, weather, prayer, Quran, currency.', section: 'OTHER SYSTEMS', aliases: ['search'] },
    { key: 'automation', title: 'AUTOMATION', description: 'Auto reply, schedules, reminders.', section: 'OTHER SYSTEMS', aliases: [] },
    { key: 'games', title: 'GAMES & LEVELS', description: 'Games, levels, coins and rewards.', section: 'OTHER SYSTEMS', aliases: ['game', 'fun', 'economy', 'bank', 'levels'] },
    { key: 'group', title: 'GROUP MANAGER', description: 'Group admin tools.', section: 'OTHER SYSTEMS', aliases: ['groups', 'admin'] },
    { key: 'system', title: 'SYSTEM', description: 'Bot info, statistics and help.', section: 'OTHER SYSTEMS', aliases: ['general', 'info'] },
    { key: 'owner', title: 'OWNER PANEL', description: 'Owners, settings, dev console.', section: 'OWNER', aliases: ['dev'], ownerOnly: true }
]);

/** Category definition for a command's `category` value (unknown → SYSTEM). */
export const categoryOf = (value) => {
    const v = String(value || 'general').toLowerCase();
    return CATEGORIES.find((c) => c.key === v || c.aliases.includes(v)) || CATEGORIES.find((c) => c.key === 'system');
};

export const findCategory = (value) => {
    const v = String(value || '').toLowerCase();
    return CATEGORIES.find((c) => c.key === v || c.aliases.includes(v) || c.title.toLowerCase() === v) || null;
};
