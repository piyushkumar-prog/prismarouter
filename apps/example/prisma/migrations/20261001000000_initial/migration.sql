-- Initial migration: invoices and customers tables

CREATE TABLE "Invoice" (
    "id"          TEXT         NOT NULL,
    "number"      TEXT         NOT NULL,
    "amountCents" INTEGER      NOT NULL,
    "status"      TEXT         NOT NULL DEFAULT 'draft',
    "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

CREATE TABLE "Customer" (
    "id"        TEXT        NOT NULL,
    "name"      TEXT        NOT NULL,
    "email"     TEXT        NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");
