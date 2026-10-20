CREATE TABLE `transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outgoing_transaction_id` integer NOT NULL,
	`incoming_transaction_id` integer NOT NULL,
	`confidence` text DEFAULT 'manual' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`outgoing_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`incoming_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "transfers_distinct_check" CHECK("transfers"."outgoing_transaction_id" <> "transfers"."incoming_transaction_id"),
	CONSTRAINT "transfers_confidence_check" CHECK("transfers"."confidence" in ('high', 'probable', 'manual')),
	CONSTRAINT "transfers_origin_check" CHECK("transfers"."origin" in ('import', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_outgoing_transaction_uq` ON `transfers` (`outgoing_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_incoming_transaction_uq` ON `transfers` (`incoming_transaction_id`);--> statement-breakpoint
ALTER TABLE `categories` ADD `color` text;--> statement-breakpoint
CREATE TRIGGER `transfers_membership_unique_insert`
BEFORE INSERT ON `transfers`
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM `transfers`
  WHERE `outgoing_transaction_id` IN (NEW.`outgoing_transaction_id`, NEW.`incoming_transaction_id`)
     OR `incoming_transaction_id` IN (NEW.`outgoing_transaction_id`, NEW.`incoming_transaction_id`)
)
BEGIN
  SELECT RAISE(ABORT, 'transaction already linked to a transfer');
END;--> statement-breakpoint
CREATE TRIGGER `transfers_membership_unique_update`
BEFORE UPDATE OF `outgoing_transaction_id`, `incoming_transaction_id` ON `transfers`
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM `transfers`
  WHERE `id` <> OLD.`id`
    AND (
      `outgoing_transaction_id` IN (NEW.`outgoing_transaction_id`, NEW.`incoming_transaction_id`)
      OR `incoming_transaction_id` IN (NEW.`outgoing_transaction_id`, NEW.`incoming_transaction_id`)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'transaction already linked to a transfer');
END;--> statement-breakpoint
CREATE TRIGGER `transfers_pair_check_insert`
BEFORE INSERT ON `transfers`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `transactions` AS `outgoing`
  JOIN `transactions` AS `incoming` ON `incoming`.`id` = NEW.`incoming_transaction_id`
  WHERE `outgoing`.`id` = NEW.`outgoing_transaction_id`
    AND `outgoing`.`amount_cents` < 0
    AND `incoming`.`amount_cents` > 0
    AND abs(`outgoing`.`amount_cents`) = abs(`incoming`.`amount_cents`)
    AND `outgoing`.`payment_method_id` <> `incoming`.`payment_method_id`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid transfer pair');
END;--> statement-breakpoint
CREATE TRIGGER `transfers_pair_check_update`
BEFORE UPDATE OF `outgoing_transaction_id`, `incoming_transaction_id` ON `transfers`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `transactions` AS `outgoing`
  JOIN `transactions` AS `incoming` ON `incoming`.`id` = NEW.`incoming_transaction_id`
  WHERE `outgoing`.`id` = NEW.`outgoing_transaction_id`
    AND `outgoing`.`amount_cents` < 0
    AND `incoming`.`amount_cents` > 0
    AND abs(`outgoing`.`amount_cents`) = abs(`incoming`.`amount_cents`)
    AND `outgoing`.`payment_method_id` <> `incoming`.`payment_method_id`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid transfer pair');
END;