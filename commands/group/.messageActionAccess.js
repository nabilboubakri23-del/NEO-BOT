import { box } from '../../utils/formatter.js';

/**
 * Who may pin/keep through the bot: anyone in a private chat; in groups only
 * group admins and bot owners (so members cannot use the bot to bypass group rules).
 * Returns true when allowed, otherwise replies and returns false.
 */
export const allowedToAct = async (m, ctx, title) => {
    if (!m.isGroup || ctx.access?.isOwner || (await ctx.access?.isAdmin?.())) return true;
    await m.reply(box(title, ['Only group admins can do this here.']));
    return false;
};
