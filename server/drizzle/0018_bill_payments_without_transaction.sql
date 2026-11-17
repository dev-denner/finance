PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- O migrator roda em transação (o PRAGMA acima não tem efeito), mas nenhuma tabela
-- referencia bill_payments: o DROP TABLE abaixo não cascateia para lugar nenhum.
CREATE TABLE `__new_bill_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bill_id` integer NOT NULL,
	`transaction_id` integer,
	`amount_cents` integer NOT NULL,
	`paid_at` text NOT NULL,
	`origin` text NOT NULL,
	`created_transaction` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`bill_id`) REFERENCES `scheduled_bills`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "bill_payments_amount_check" CHECK("__new_bill_payments"."amount_cents" > 0),
	CONSTRAINT "bill_payments_origin_check" CHECK("__new_bill_payments"."origin" IN ('manual', 'import_match', 'migration'))
);
--> statement-breakpoint
INSERT INTO `__new_bill_payments`("id", "bill_id", "transaction_id", "amount_cents", "paid_at", "origin", "created_transaction", "created_at") SELECT "id", "bill_id", "transaction_id", "amount_cents", "paid_at", "origin", "created_transaction", "created_at" FROM `bill_payments`;--> statement-breakpoint
DROP TABLE `bill_payments`;--> statement-breakpoint
ALTER TABLE `__new_bill_payments` RENAME TO `bill_payments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `bill_payments_transaction_uq` ON `bill_payments` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `bill_payments_bill_idx` ON `bill_payments` (`bill_id`);