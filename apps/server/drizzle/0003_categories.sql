CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"blurb" text NOT NULL,
	"icon" text NOT NULL,
	"color" text NOT NULL,
	"work_timeout_ms" integer NOT NULL,
	"manual_timeout_ms" integer NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- The starting catalogue; adding a category is adding a row.
INSERT INTO "categories" ("id", "title", "blurb", "icon", "color", "work_timeout_ms", "manual_timeout_ms", "tags", "sort") VALUES
	('data.market', '竞品/市场数据', '查竞品门店、价格、评价等市场数据', '竞品', '#1677ff', 600000, 86400000, '{"竞品","门店","价格","评价","选址"}', 10),
	('data.research', '网页调研与资料整理', '上网查资料，整理成清单或报告', '调研', '#2f54eb', 1200000, 86400000, '{"调研","资料","行业","报告"}', 20),
	('data.cleaning', '数据清洗与表格处理', '清洗、去重、合并数据，整理 Excel / CSV', '表格', '#13c2c2', 900000, 86400000, '{"Excel","CSV","表格","清洗","去重"}', 30),
	('content.writing', '文案写作', '写文案、帖子、广告语和产品介绍', '文案', '#eb2f96', 900000, 86400000, '{"文案","小红书","公众号","广告语"}', 40),
	('content.translation', '翻译', '中外互译和本地化', '翻译', '#f5222d', 900000, 86400000, '{"翻译","英文","日文","本地化"}', 50),
	('content.summary', '摘要/会议纪要', '把长文、录音或会议整理成摘要和纪要', '纪要', '#fa541c', 600000, 43200000, '{"摘要","纪要","总结"}', 60),
	('design.chart', '图表与可视化', '把数据画成图表或报告配图', '图表', '#00b578', 600000, 43200000, '{"图表","柱状图","对比","可视化"}', 70),
	('design.image', '图片设计/海报', '做海报、封面、配图和 logo', '设计', '#52c41a', 1200000, 172800000, '{"海报","封面","配图","logo"}', 80),
	('media.video', '视频剪辑', '剪视频、加字幕、配乐', '剪辑', '#722ed1', 3600000, 259200000, '{"剪辑","字幕","配乐","短视频","mp4"}', 90),
	('media.audio', '音频处理/配音', '配音、降噪、剪音频', '音频', '#9254de', 1800000, 172800000, '{"配音","降噪","播客","音频"}', 100),
	('dev.code', '写代码/脚本', '写脚本、小工具和自动化程序', '代码', '#262626', 1800000, 172800000, '{"脚本","爬虫","Python","自动化"}', 110),
	('dev.review', '代码审查', '看代码，指出 bug、风险和改进点', '审查', '#434343', 1200000, 86400000, '{"代码审查","review","安全"}', 120),
	('dev.debug', 'bug 排查', '定位报错和性能问题，给出修复', '排查', '#595959', 1800000, 86400000, '{"bug","报错","排查","性能"}', 130),
	('dev.ops', '部署运维', '部署服务、配服务器、域名和监控', '运维', '#1d39c4', 1800000, 86400000, '{"部署","服务器","Docker","域名"}', 140),
	('onsite.photo', '实地拍照/探店', '去指定地点拍照、探店', '拍照', '#ff8f1f', 7200000, 14400000, '{"拍照","探店","门头","排队"}', 150),
	('onsite.errand', '线下跑腿/代办', '代取代送、排队、线下代办', '跑腿', '#fa8c16', 7200000, 21600000, '{"跑腿","代取","代办","排队"}', 160),
	('human.verify', '人工核验/打电话', '打电话确认、人工核实信息', '核验', '#d48806', 3600000, 21600000, '{"核验","打电话","确认","回访"}', 170),
	('human.survey', '问卷与用户访谈', '发问卷、约访谈，整理用户反馈', '访谈', '#d4b106', 7200000, 259200000, '{"问卷","访谈","用户调研"}', 180),
	('other.consult', '咨询/专家意见', '请懂行的人给建议', '咨询', '#08979c', 3600000, 172800000, '{"咨询","专家","建议"}', 190),
	('other.misc', '其他', '不属于上面几类的活', '其他', '#8c8c8c', 3600000, 86400000, '{}', 200);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_accounts_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_order" ON "files" USING btree ("order_id");--> statement-breakpoint
-- Capability types become categories: same rows, mapped to the new catalogue.
ALTER TABLE "listings" RENAME COLUMN "capability_type" TO "category";--> statement-breakpoint
UPDATE "listings" SET "category" = CASE "category" WHEN 'market-data.competitors' THEN 'data.market' WHEN 'chart.compare' THEN 'design.chart' WHEN 'photo.onsite' THEN 'onsite.photo' ELSE 'other.misc' END;--> statement-breakpoint
DROP INDEX "listings_seller_type";--> statement-breakpoint
CREATE UNIQUE INDEX "listings_seller_category" ON "listings" USING btree ("seller_account_id","category");--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_categories_id_fk" FOREIGN KEY ("category") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "intro" text;--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "capability_type" TO "category";--> statement-breakpoint
UPDATE "orders" SET "category" = CASE "category" WHEN 'market-data.competitors' THEN 'data.market' WHEN 'chart.compare' THEN 'design.chart' WHEN 'photo.onsite' THEN 'onsite.photo' ELSE 'other.misc' END;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_category_categories_id_fk" FOREIGN KEY ("category") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "input" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "brief" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_spec" jsonb DEFAULT '{"kind":"any"}'::jsonb NOT NULL;--> statement-breakpoint
-- Older orders had no brief and delivered a bare object: that object becomes the delivery's data,
-- and from here on they're checked as "any".
UPDATE "orders" SET "brief" = '（旧订单，需求见附加数据）';--> statement-breakpoint
UPDATE "orders" SET "output" = jsonb_build_object('note', null, 'data', "output", 'files', '[]'::jsonb) WHERE "output" IS NOT NULL;
