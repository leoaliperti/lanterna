CREATE TABLE `content` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`campaign_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_key_unique` ON `content` (`key`);--> statement-breakpoint
CREATE INDEX `content_kind_name_idx` ON `content` (`kind`,`name`);--> statement-breakpoint
CREATE INDEX `content_campaign_idx` ON `content` (`campaign_id`);