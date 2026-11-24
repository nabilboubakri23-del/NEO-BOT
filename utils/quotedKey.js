/**
 * The full message key of the message a command replies to (or null).
 * Group keys need the original sender as `participant`, which reply context
 * sometimes leaves out.
 */
export const quotedKey = (m) => {
    if (!m.quoted?.key?.id) return null;
    const key = { ...m.quoted.key };
    if (!key.participant && m.isGroup && m.quoted.sender) key.participant = m.quoted.sender;
    return key;
};
