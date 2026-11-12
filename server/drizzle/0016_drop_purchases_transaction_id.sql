PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- O migrator roda em transação, onde PRAGMA foreign_keys não tem efeito: o DROP TABLE
-- abaixo apagaria em cascata purchase_items e purchase_settlements e falharia pela
-- restrição de payment_balance_adjustments.purchase_id. As tabelas auxiliares guardam
-- essas linhas e as restauram, com os mesmos ids, após o RENAME.
CREATE TABLE `__purchase_items_backup` AS SELECT * FROM `purchase_items`;--> statement-breakpoint
CREATE TABLE `__purchase_settlements_backup` AS SELECT * FROM `purchase_settlements`;--> statement-breakpoint
CREATE TABLE `__payment_balance_adjustments_backup` AS SELECT * FROM `payment_balance_adjustments` WHERE `purchase_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `payment_balance_adjustments` WHERE `purchase_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_key` text NOT NULL,
	`supplier_name` text NOT NULL,
	`supplier_cnpj` text NOT NULL,
	`invoice_number` text NOT NULL,
	`series` text NOT NULL,
	`issued_at` text NOT NULL,
	`total_cents` integer NOT NULL,
	`invoice_discount_cents` integer DEFAULT 0 NOT NULL,
	`payment_method` text,
	`category_id` integer,
	`reconciled_at` text,
	`reconciliation_previous_category_id` integer,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_purchases`("id", "access_key", "supplier_name", "supplier_cnpj", "invoice_number", "series", "issued_at", "total_cents", "invoice_discount_cents", "payment_method", "category_id", "reconciled_at", "reconciliation_previous_category_id", "imported_at") SELECT "id", "access_key", "supplier_name", "supplier_cnpj", "invoice_number", "series", "issued_at", "total_cents", "invoice_discount_cents", "payment_method", "category_id", "reconciled_at", "reconciliation_previous_category_id", "imported_at" FROM `purchases`;--> statement-breakpoint
DROP TABLE `purchases`;--> statement-breakpoint
ALTER TABLE `__new_purchases` RENAME TO `purchases`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_access_key_uq` ON `purchases` (`access_key`);--> statement-breakpoint
CREATE INDEX `purchases_issued_at_idx` ON `purchases` (`issued_at`);--> statement-breakpoint
INSERT INTO `purchase_items` SELECT * FROM `__purchase_items_backup` WHERE `id` NOT IN (SELECT `id` FROM `purchase_items`);--> statement-breakpoint
INSERT INTO `purchase_settlements` SELECT * FROM `__purchase_settlements_backup` WHERE `id` NOT IN (SELECT `id` FROM `purchase_settlements`);--> statement-breakpoint
INSERT INTO `payment_balance_adjustments` SELECT * FROM `__payment_balance_adjustments_backup` WHERE `id` NOT IN (SELECT `id` FROM `payment_balance_adjustments`);--> statement-breakpoint
DROP TABLE `__purchase_items_backup`;--> statement-breakpoint
DROP TABLE `__purchase_settlements_backup`;--> statement-breakpoint
DROP TABLE `__payment_balance_adjustments_backup`;
