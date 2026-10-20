CREATE TABLE `scheduled_bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT '' NOT NULL,
	`category_id` integer NOT NULL,
	`repeated_from_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`repeated_from_id`) REFERENCES `scheduled_bills`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "scheduled_bills_status_check" CHECK("scheduled_bills"."status" IN ('', 'AG', 'PG')),
	CONSTRAINT "scheduled_bills_amount_check" CHECK("scheduled_bills"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX `scheduled_bills_due_date_idx` ON `scheduled_bills` (`due_date`);--> statement-breakpoint
CREATE INDEX `scheduled_bills_category_idx` ON `scheduled_bills` (`category_id`);--> statement-breakpoint
CREATE INDEX `scheduled_bills_repeated_from_idx` ON `scheduled_bills` (`repeated_from_id`);