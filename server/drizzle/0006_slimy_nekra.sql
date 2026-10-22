CREATE TABLE `bill_reminder_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`milestone` text NOT NULL,
	`send_date` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`sent_at` text,
	`item_count` integer DEFAULT 0 NOT NULL,
	`recipient` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "bill_reminder_batches_state_check" CHECK("bill_reminder_batches"."state" in ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "bill_reminder_batches_attempts_check" CHECK("bill_reminder_batches"."attempts" >= 0),
	CONSTRAINT "bill_reminder_batches_item_count_check" CHECK("bill_reminder_batches"."item_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_reminder_batches_milestone_send_date_uq` ON `bill_reminder_batches` (`milestone`,`send_date`);--> statement-breakpoint
CREATE INDEX `bill_reminder_batches_state_idx` ON `bill_reminder_batches` (`state`);--> statement-breakpoint
CREATE INDEX `bill_reminder_batches_send_date_idx` ON `bill_reminder_batches` (`send_date`);--> statement-breakpoint
CREATE TABLE `bill_reminder_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`milestone` text NOT NULL,
	`due_date` text NOT NULL,
	`send_date` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`sent_at` text,
	`batch_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `scheduled_bills`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `bill_reminder_batches`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "bill_reminder_notifications_state_check" CHECK("bill_reminder_notifications"."state" in ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "bill_reminder_notifications_attempts_check" CHECK("bill_reminder_notifications"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_reminder_notifications_bill_milestone_due_date_uq` ON `bill_reminder_notifications` (`bill_id`,`milestone`,`due_date`);--> statement-breakpoint
CREATE INDEX `bill_reminder_notifications_bill_id_idx` ON `bill_reminder_notifications` (`bill_id`);--> statement-breakpoint
CREATE INDEX `bill_reminder_notifications_state_idx` ON `bill_reminder_notifications` (`state`);--> statement-breakpoint
CREATE INDEX `bill_reminder_notifications_batch_id_idx` ON `bill_reminder_notifications` (`batch_id`);