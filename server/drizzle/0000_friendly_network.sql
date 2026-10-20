CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_normalized_name_uq` ON `categories` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`total_rows` integer NOT NULL,
	`imported_rows` integer NOT NULL,
	`rejected_rows` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_methods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_methods_normalized_name_uq` ON `payment_methods` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_date` text NOT NULL,
	`due_date` text NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`payment_method_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`installment_number` integer,
	`installment_total` integer,
	`transfer` text,
	`import_batch_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "transactions_installments_check" CHECK(("transactions"."installment_number" is null or "transactions"."installment_number" >= 1)
        and ("transactions"."installment_total" is null or "transactions"."installment_total" >= 1)
        and ("transactions"."installment_number" is null or "transactions"."installment_total" is null
          or "transactions"."installment_number" <= "transactions"."installment_total"))
);
--> statement-breakpoint
CREATE INDEX `transactions_due_date_idx` ON `transactions` (`due_date`);--> statement-breakpoint
CREATE INDEX `transactions_purchase_date_idx` ON `transactions` (`purchase_date`);--> statement-breakpoint
CREATE INDEX `transactions_category_id_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_payment_method_id_idx` ON `transactions` (`payment_method_id`);--> statement-breakpoint
CREATE INDEX `transactions_import_batch_id_idx` ON `transactions` (`import_batch_id`);