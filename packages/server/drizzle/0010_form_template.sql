CREATE TABLE `form_template` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pages` integer NOT NULL,
	`fields` text NOT NULL,
	`pdf_file` text NOT NULL,
	`pdf_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
