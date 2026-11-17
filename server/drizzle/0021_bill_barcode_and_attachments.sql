CREATE TABLE `bill_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `scheduled_bills`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "bill_attachments_size_check" CHECK("bill_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX `bill_attachments_bill_idx` ON `bill_attachments` (`bill_id`);--> statement-breakpoint
ALTER TABLE `scheduled_bills` ADD `barcode` text;