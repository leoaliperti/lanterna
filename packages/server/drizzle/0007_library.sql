CREATE TABLE `library_item` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_item_campaign_idx` ON `library_item` (`campaign_id`,`name`);