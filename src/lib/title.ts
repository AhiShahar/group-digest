// The name a group shows under in Nutshell: the person's own name for it, or WhatsApp's.
export const chatTitle = (c: { name: string; alias?: string }): string => c.alias?.trim() || c.name;
