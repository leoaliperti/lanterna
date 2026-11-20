CREATE TABLE `character_sheet` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner_user_id` text,
	`token_id` text,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `character_sheet_campaign_idx` ON `character_sheet` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `character_sheet_owner_idx` ON `character_sheet` (`campaign_id`,`owner_user_id`);