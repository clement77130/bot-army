import { EmbedBuilder } from 'discord.js';
import type { UpdateResult } from './robloxSync';

export function buildUpdateEmbed(result: UpdateResult, title = '🔄 Mise à jour Roblox'): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(result.warnings.length ? '#ffa500' : '#00b06f').setTitle(title).setTimestamp();

  if (result.linked) {
    embed.setDescription(
      `Compte Roblox : **${result.robloxUsername}** ([profil](https://www.roblox.com/users/${result.robloxId}/profile))`
    );
  } else {
    embed.setDescription('Ce membre n\'a pas de compte Roblox lié. Utilisez `/verify` pour en lier un.');
  }

  embed.addFields(
    {
      name: '➕ Rôles ajoutés',
      value: result.added.length ? result.added.map(id => `<@&${id}>`).join(', ') : 'Aucun',
      inline: true
    },
    {
      name: '➖ Rôles retirés',
      value: result.removed.length ? result.removed.map(id => `<@&${id}>`).join(', ') : 'Aucun',
      inline: true
    }
  );

  if (result.nickname) embed.addFields({ name: '✏️ Pseudo', value: result.nickname, inline: false });
  if (result.warnings.length) {
    embed.addFields({ name: '⚠️ Avertissements', value: result.warnings.join('\n').slice(0, 1000), inline: false });
  }

  return embed;
}
