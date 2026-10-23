CREATE TABLE `purchase_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` text NOT NULL,
	`unit` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`discount_cents` integer,
	`total_cents` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_items_purchase_position_uq` ON `purchase_items` (`purchase_id`,`position`);--> statement-breakpoint
CREATE INDEX `purchase_items_purchase_id_idx` ON `purchase_items` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_key` text NOT NULL,
	`supplier_name` text NOT NULL,
	`supplier_cnpj` text NOT NULL,
	`invoice_number` text NOT NULL,
	`series` text NOT NULL,
	`issued_at` text NOT NULL,
	`total_cents` integer NOT NULL,
	`payment_method` text,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_access_key_uq` ON `purchases` (`access_key`);--> statement-breakpoint
CREATE INDEX `purchases_issued_at_idx` ON `purchases` (`issued_at`);