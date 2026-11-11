CREATE TABLE `bill_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`paid_at` text NOT NULL,
	`origin` text NOT NULL,
	`created_transaction` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `scheduled_bills`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "bill_payments_amount_check" CHECK("bill_payments"."amount_cents" > 0),
	CONSTRAINT "bill_payments_origin_check" CHECK("bill_payments"."origin" IN ('manual', 'import_match', 'migration'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_payments_transaction_uq` ON `bill_payments` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `bill_payments_bill_idx` ON `bill_payments` (`bill_id`);--> statement-breakpoint
CREATE TABLE `bill_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`amount_min_cents` integer,
	`amount_max_cents` integer,
	`category_id` integer NOT NULL,
	`payment_method_id` integer,
	`frequency` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`day_of_month` integer,
	`weekday` integer,
	`month_of_year` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`occurrence_count` integer,
	`active` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "bill_templates_amount_check" CHECK("bill_templates"."amount_cents" > 0),
	CONSTRAINT "bill_templates_frequency_check" CHECK("bill_templates"."frequency" IN ('monthly', 'weekly', 'yearly')),
	CONSTRAINT "bill_templates_interval_check" CHECK("bill_templates"."interval" >= 1),
	CONSTRAINT "bill_templates_occurrence_count_check" CHECK("bill_templates"."occurrence_count" IS NULL OR "bill_templates"."occurrence_count" >= 1),
	CONSTRAINT "bill_templates_amount_range_check" CHECK(("bill_templates"."amount_min_cents" IS NULL OR "bill_templates"."amount_min_cents" > 0)
        AND ("bill_templates"."amount_max_cents" IS NULL OR "bill_templates"."amount_max_cents" > 0)
        AND ("bill_templates"."amount_min_cents" IS NULL OR "bill_templates"."amount_max_cents" IS NULL
          OR "bill_templates"."amount_min_cents" <= "bill_templates"."amount_max_cents"))
);
--> statement-breakpoint
CREATE INDEX `bill_templates_category_idx` ON `bill_templates` (`category_id`);--> statement-breakpoint
CREATE INDEX `bill_templates_active_idx` ON `bill_templates` (`active`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- O migrator roda em transação, onde PRAGMA foreign_keys não tem efeito: o DROP TABLE
-- abaixo dispararia ON DELETE SET NULL na auto-referência repeated_from_id da tabela
-- nova e ON DELETE CASCADE em bill_reminder_notifications. As tabelas auxiliares
-- guardam esses dados e os restauram após o RENAME.
CREATE TABLE `__scheduled_bills_repeat_backup` AS SELECT `id`, `repeated_from_id` FROM `scheduled_bills` WHERE `repeated_from_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__bill_reminder_notifications_backup` AS SELECT * FROM `bill_reminder_notifications`;--> statement-breakpoint
CREATE TABLE `__new_scheduled_bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer,
	`sequence` integer,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`due_date` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`scheduled_for` text,
	`paid_at` text,
	`paid_cents` integer,
	`category_id` integer NOT NULL,
	`payment_method_id` integer,
	`notes` text,
	`migrated_payment` integer DEFAULT 0 NOT NULL,
	`repeated_from_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `bill_templates`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`repeated_from_id`) REFERENCES `scheduled_bills`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "scheduled_bills_state_check" CHECK("__new_scheduled_bills"."state" IN ('open', 'paid', 'skipped')),
	CONSTRAINT "scheduled_bills_amount_check" CHECK("__new_scheduled_bills"."amount_cents" > 0),
	CONSTRAINT "scheduled_bills_paid_check" CHECK(("__new_scheduled_bills"."state" <> 'paid') OR ("__new_scheduled_bills"."paid_at" IS NOT NULL AND "__new_scheduled_bills"."paid_cents" IS NOT NULL AND "__new_scheduled_bills"."paid_cents" > 0)),
	CONSTRAINT "scheduled_bills_sequence_check" CHECK("__new_scheduled_bills"."sequence" IS NULL OR "__new_scheduled_bills"."sequence" >= 1)
);
--> statement-breakpoint
-- Migração de dados: status legado ('', AG, PG) vira state + datas.
-- PG não tem lançamento para apontar; fica pago com migrated_payment = 1.
INSERT INTO `__new_scheduled_bills`("id", "template_id", "sequence", "description", "amount_cents", "due_date", "state", "scheduled_for", "paid_at", "paid_cents", "category_id", "payment_method_id", "notes", "migrated_payment", "repeated_from_id", "created_at", "updated_at")
SELECT "id", NULL, NULL, "description", "amount_cents", "due_date",
  CASE "status" WHEN 'PG' THEN 'paid' ELSE 'open' END,
  CASE "status" WHEN 'AG' THEN "due_date" ELSE NULL END,
  CASE "status" WHEN 'PG' THEN "due_date" ELSE NULL END,
  CASE "status" WHEN 'PG' THEN "amount_cents" ELSE NULL END,
  "category_id", NULL, NULL,
  CASE "status" WHEN 'PG' THEN 1 ELSE 0 END,
  NULL, "created_at", "updated_at"
FROM `scheduled_bills`;--> statement-breakpoint
DROP TABLE `scheduled_bills`;--> statement-breakpoint
ALTER TABLE `__new_scheduled_bills` RENAME TO `scheduled_bills`;--> statement-breakpoint
UPDATE `scheduled_bills` SET `repeated_from_id` = (SELECT `repeated_from_id` FROM `__scheduled_bills_repeat_backup` b WHERE b.`id` = `scheduled_bills`.`id`) WHERE `id` IN (SELECT `id` FROM `__scheduled_bills_repeat_backup`);--> statement-breakpoint
DROP TABLE `__scheduled_bills_repeat_backup`;--> statement-breakpoint
INSERT INTO `bill_reminder_notifications` SELECT * FROM `__bill_reminder_notifications_backup` WHERE `id` NOT IN (SELECT `id` FROM `bill_reminder_notifications`);--> statement-breakpoint
DROP TABLE `__bill_reminder_notifications_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_bills_template_sequence_uq` ON `scheduled_bills` (`template_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `scheduled_bills_due_date_idx` ON `scheduled_bills` (`due_date`);--> statement-breakpoint
CREATE INDEX `scheduled_bills_state_due_date_idx` ON `scheduled_bills` (`state`,`due_date`);--> statement-breakpoint
CREATE INDEX `scheduled_bills_category_idx` ON `scheduled_bills` (`category_id`);--> statement-breakpoint
CREATE INDEX `scheduled_bills_repeated_from_idx` ON `scheduled_bills` (`repeated_from_id`);