export function isOwnerPrivateUpdate(update, ownerUserId) {
  const actorId = update.message?.from?.id ?? update.callback_query?.from?.id;
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;

  return Boolean(ownerUserId)
    && actorId !== undefined
    && chat?.type === "private"
    && String(actorId) === String(ownerUserId)
    && String(chat.id) === String(ownerUserId);
}
