CREATE TABLE `chat_entry` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`author_id` text NOT NULL,
	`visibility` text NOT NULL,
	`whisper_to` text,
	`at` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_entry_id_unique` ON `chat_entry` (`id`);--> statement-breakpoint
CREATE INDEX `chat_entry_campaign_seq_idx` ON `chat_entry` (`campaign_id`,`seq`);