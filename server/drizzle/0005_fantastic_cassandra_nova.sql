CREATE TABLE `category_import_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_normalized_name` text NOT NULL,
	`target_category_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`target_category_id`) REFERENCES `categories`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_import_aliases_source_uq` ON `category_import_aliases` (`source_normalized_name`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `due_date_source` text;