CREATE TABLE `import_mapping_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`headers` text NOT NULL,
	`mapping` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_mapping_templates_name_uq` ON `import_mapping_templates` (`name`);--> statement-breakpoint
ALTER TABLE `import_batches` ADD `mapping_template_id` integer REFERENCES import_mapping_templates(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `purchase_date_source` text;