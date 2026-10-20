CREATE TABLE `transfer_rejections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outgoing_transaction_id` integer NOT NULL,
	`incoming_transaction_id` integer NOT NULL,
	`signature` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`outgoing_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`incoming_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "transfer_rejections_distinct_check" CHECK("transfer_rejections"."outgoing_transaction_id" <> "transfer_rejections"."incoming_transaction_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_rejections_pair_uq` ON `transfer_rejections` (`outgoing_transaction_id`,`incoming_transaction_id`);--> statement-breakpoint
ALTER TABLE `categories` ADD `classification` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `installment_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `installment_original` text;