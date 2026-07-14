import { PrismaClient } from "../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create dev user
  const user = await prisma.user.upsert({
    where: { email: "dev@clira.local" },
    update: {},
    create: {
      email: "dev@clira.local",
      name: "Dev User",
      settings: {
        create: {
          autonomyLevel: 0,
          replyScope: "CONTACTS_ONLY",
          notificationDeliveryChannel: "BOTH",
        },
      },
    },
  });

  console.log(`User: ${user.email} (${user.id})`);

  // Create primary mailbox
  const mailbox = await prisma.mailbox.upsert({
    where: {
      userId_provider_providerAccountId: {
        userId: user.id,
        provider: "google",
        providerAccountId: "dev-account-id",
      },
    },
    update: {},
    create: {
      userId: user.id,
      provider: "google",
      providerAccountId: "dev-account-id",
      emailAddress: "dev@clira.local",
      displayName: "Dev Mailbox",
      isPrimary: true,
      status: "CONNECTED",
    },
  });

  console.log(`Mailbox: ${mailbox.emailAddress} (${mailbox.id})`);

  // Create default MasterPrompt
  const masterPrompt = await prisma.masterPrompt.upsert({
    where: { id: "seed-master-prompt" },
    update: {},
    create: {
      id: "seed-master-prompt",
      userId: user.id,
      prompt: `You are a professional AI executive assistant helping manage email communications.

Your role is to:
- Draft thoughtful, professional replies that match the user's communication style
- Identify action items and follow-ups
- Maintain context across email threads
- Always be accurate and never fabricate information

The user prefers concise, direct communication with a professional but approachable tone.`,
      version: 1,
      isActive: true,
      isGenerated: false,
    },
  });

  console.log(`MasterPrompt: ${masterPrompt.id}`);

  console.log("\nSeed complete.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
