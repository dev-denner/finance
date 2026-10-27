ALTER TABLE `payment_balance_adjustments` ADD `purchase_id` integer REFERENCES purchases(id);--> statement-breakpoint
ALTER TABLE `payment_balance_adjustments` ADD `reversed_at` text;--> statement-breakpoint
CREATE INDEX `payment_balance_adjustments_purchase_idx` ON `payment_balance_adjustments` (`purchase_id`);