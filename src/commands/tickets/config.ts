import { 
  SlashCommandBuilder, 
  ChannelType, 
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
  ChatInputCommandInteraction
} from 'discord.js';
import { prisma } from '../../utils/prisma';
import { isStaff } from '../../utils/ticketUtils';
import { closeTicket, reopenTicket } from '../../utils/ticketActions';


export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Configurer et gérer le système de tickets')
  .addSubcommand(subcommand =>
    subcommand
      .setName('category')
      .setDescription('Définir la catégorie des tickets')
      .addChannelOption(option =>
        option.setName('category')
          .setDescription('La catégorie où seront créés les tickets')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildCategory)))
  .addSubcommand(subcommand =>
    subcommand
      .setName('message')
      .setDescription('Envoyer le message de création de ticket')
      .addChannelOption(option =>
        option.setName('channel')
          .setDescription('Le salon où envoyer le message')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(subcommand =>
    subcommand
      .setName('close')
      .setDescription('Fermer un ticket'))
  .addSubcommand(subcommand =>
    subcommand
      .setName('reopen')
      .setDescription('Réouvrir un ticket'))
  // Pas de permission par défaut : category/message (admin) et close/reopen (staff) sont vérifiés dans execute()
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    return interaction.reply({
      content: 'Cette commande doit être utilisée dans un serveur.',
      ephemeral: true
    });
  }

  const subcommand = interaction.options.getSubcommand();

  if (
    (subcommand === 'category' || subcommand === 'message') &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: 'Vous devez être administrateur pour utiliser cette commande.',
      ephemeral: true
    });
  }

  switch (subcommand) {
    case 'category': {
      const category = interaction.options.getChannel('category', true);
      if (category.type !== ChannelType.GuildCategory) {
        return interaction.reply({
          content: 'Vous devez sélectionner une catégorie.',
          ephemeral: true
        });
      }
      
      await prisma.guild.upsert({
        where: { id: interaction.guildId },
        update: {
          ticketCategoryId: category.id
        },
        create: {
          id: interaction.guildId,
          ticketCategoryId: category.id
        }
      });

      await interaction.reply({
        content: `La catégorie des tickets a été définie sur ${category.name}`,
        ephemeral: true
      });
      break;
    }

    case 'message': {
      const channel = interaction.options.getChannel('channel', true);
      if (channel.type !== ChannelType.GuildText) {
        return interaction.reply({
          content: 'Vous devez sélectionner un salon textuel.',
          ephemeral: true
        });
      }

      const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('ticket_create')
            .setPlaceholder('Sélectionnez une catégorie')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions([
              {
                label: 'Bug',
                description: 'Signaler un bug',
                value: 'bug',
                emoji: '🐛'
              },
              {
                label: 'Réclamation de récompense',
                description: 'Réclamer une récompense',
                value: 'reward',
                emoji: '🎁'
              },
              {
                label: 'Signalement',
                description: 'Signaler un utilisateur',
                value: 'report',
                emoji: '🚨'
              }
            ])
        );

      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🎫 Création de ticket')
        .setDescription('Sélectionnez une catégorie pour créer un ticket')
        .setTimestamp();

      await channel.send({
        embeds: [embed],
        components: [row]
      });

      await interaction.reply({
        content: 'Le message de création de ticket a été envoyé',
        ephemeral: true
      });
      break;
    }

    case 'close':
    case 'reopen': {
      if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
        return interaction.reply({
          content: 'Cette commande doit être utilisée dans un ticket.',
          ephemeral: true
        });
      }

      const ticket = await prisma.ticket.findFirst({
        where: { OR: [{ id: interaction.channelId }, { channelId: interaction.channelId }] }
      });

      if (!ticket) {
        return interaction.reply({
          content: 'Cette commande doit être utilisée dans un ticket.',
          ephemeral: true
        });
      }

      const staff = await isStaff(interaction.member);
      const allowed = subcommand === 'close' ? staff || ticket.userId === interaction.user.id : staff;
      if (!allowed) {
        return interaction.reply({
          content: 'Vous n\'avez pas la permission de gérer ce ticket.',
          ephemeral: true
        });
      }

      const channel = interaction.channel as TextChannel;

      if (subcommand === 'close' && ticket.status === 'closed') {
        return interaction.reply({ content: 'Ce ticket est déjà fermé.', ephemeral: true });
      }
      if (subcommand === 'reopen' && ticket.status === 'open') {
        return interaction.reply({ content: 'Ce ticket est déjà ouvert.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        if (subcommand === 'close') {
          await closeTicket(channel, ticket, interaction.user.tag);
          await interaction.editReply({ content: 'Le ticket a été fermé.' });
        } else {
          await reopenTicket(channel, ticket, interaction.user.tag);
          await interaction.editReply({ content: 'Le ticket a été réouvert.' });
        }
      } catch (error) {
        console.error(`[ERROR] Error during ticket ${subcommand}:`, error);
        await interaction.editReply({ content: 'Une erreur est survenue lors de l\'opération sur le ticket.' });
      }
      break;
    }
  }
}
