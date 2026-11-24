CREATE TABLE `game_log` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`version` integer NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`lines` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_log_campaign_idx` ON `game_log` (`campaign_id`,`version`);