CREATE TABLE `combat` (
	`campaign_id` text NOT NULL,
	`scene_id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `scene_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `token_group` (
	`campaign_id` text NOT NULL,
	`id` text NOT NULL,
	`sort` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
