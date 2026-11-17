CREATE TABLE `purchase_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`position` integer NOT NULL,
	`method` text NOT NULL,
	`amount_cents` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "purchase_payments_amount_check" CHECK("purchase_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_payments_purchase_position_uq` ON `purchase_payments` (`purchase_id`,`position`);--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `code` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `ean` text;