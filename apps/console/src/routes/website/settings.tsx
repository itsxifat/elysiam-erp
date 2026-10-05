import type {
  Announcement,
  PaymentMethods,
  PromoBanner,
  ShippingRuleInput,
  SiteInfo,
  SocialLinks,
  StorefrontSettingsPatch,
  Testimonial,
} from '@elysium/contracts';
import { Button, Checkbox, Section, Select, poishaToTaka, takaToPoisha } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { getSettings, saveSettings, type WebsiteSettings } from './api.js';
import { useWebsiteT, type WebsiteMessageKey } from './messages.js';
import { control, Field, ImagePicker, Loadable, Preview, Problem, WebsitePage } from './parts.js';

/**
 * Website → Settings (M33, D-503): the site's information, social links, announcement bar,
 * promo banner, testimonials, shipping rule, payment methods and where the website sells
 * from — each a section with its own Save, so saving the banner never resends the shipping
 * rule somebody else is editing. The server merges a section into the rest.
 */
export function WebsiteSettingsPage() {
  const query = useQuery({ queryKey: ['website', 'settings'], queryFn: getSettings });
  return (
    <WebsitePage tab="/website/settings">
      <Loadable query={query}>{(settings) => <SettingsSections settings={settings} />}</Loadable>
    </WebsitePage>
  );
}

function SettingsSections({ settings }: { readonly settings: WebsiteSettings }) {
  return (
    <div className="space-y-5">
      <SiteInfoSection value={settings.siteInfo} />
      <SocialSection value={settings.social} />
      <AnnouncementSection value={settings.announcement} />
      <PromoSection value={settings.promoBanner} />
      <TestimonialsSection value={settings.testimonials} />
      <ShippingSection value={settings.shipping} options={settings.options} />
      <PaymentsSection value={settings.payments} />
      <LocationsSection value={settings.webLocationIds} options={settings.options} />
    </div>
  );
}

/** One section's frame: its title, its fields and its own Save. */
function SettingsSection({
  title,
  description,
  patch,
  disabled,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  /** What this section's Save sends. */
  readonly patch: () => StorefrontSettingsPatch;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  const t = useWebsiteT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'Storefront');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => saveSettings(patch()),
    onSuccess: (next) => {
      queryClient.setQueryData(['website', 'settings'], next);
      setSaved(true);
    },
    onMutate: () => setSaved(false),
  });
  return (
    <Section
      title={title}
      {...(description === undefined ? {} : { description })}
      actions={
        mayUpdate ? (
          <div className="flex items-center gap-3">
            {saved ? (
              <span role="status" className="text-xs text-muted-foreground">
                {t('web.saved')}
              </span>
            ) : null}
            <Button
              size="sm"
              disabled={disabled === true || save.isPending}
              onClick={() => save.mutate()}
            >
              {t('web.save')}
            </Button>
          </div>
        ) : null
      }
    >
      <fieldset disabled={!mayUpdate} className="space-y-4">
        {children}
        <Problem error={save.error} />
      </fieldset>
    </Section>
  );
}

function TextInput({
  label,
  value,
  onChange,
  max,
  hint,
  type = 'text',
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly max: number;
  readonly hint?: string;
  readonly type?: 'text' | 'email' | 'url' | 'tel';
}) {
  const id = useId();
  return (
    <Field id={id} label={label} hint={hint}>
      <input
        id={id}
        type={type}
        value={value}
        maxLength={max}
        className={control}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function TextArea({
  label,
  value,
  onChange,
  max,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly max: number;
}) {
  const id = useId();
  return (
    <Field id={id} label={label}>
      <textarea
        id={id}
        value={value}
        maxLength={max}
        rows={3}
        className={`${control} h-auto py-2`}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {label}
    </label>
  );
}

function SiteInfoSection({ value }: { readonly value: SiteInfo }) {
  const t = useWebsiteT();
  const [info, setInfo] = useState(value);
  const set = (patch: Partial<SiteInfo>) => setInfo((current) => ({ ...current, ...patch }));
  return (
    <SettingsSection
      title={t('web.settings.siteInfo')}
      description={t('web.settings.siteInfoHelp')}
      patch={() => ({ siteInfo: info })}
      disabled={info.siteName.trim() === ''}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          label={t('web.settings.siteName')}
          value={info.siteName}
          max={120}
          onChange={(siteName) => set({ siteName })}
        />
        <TextInput
          label={t('web.settings.siteUrl')}
          value={info.siteUrl}
          max={300}
          type="url"
          onChange={(siteUrl) => set({ siteUrl })}
        />
      </div>
      <div className="space-y-1.5 text-sm">
        <p className="font-medium">{t('web.settings.logo')}</p>
        <div className="flex flex-wrap items-center gap-3">
          {info.logoFileId === null ? null : (
            <Preview fileId={info.logoFileId} alt={t('web.settings.logo')} className="h-12 w-28" />
          )}
          <ImagePicker
            purpose="storefront-image"
            onUploaded={(logoFileId) => set({ logoFileId })}
          />
          {info.logoFileId === null ? null : (
            <Button size="sm" variant="ghost" onClick={() => set({ logoFileId: null })}>
              {t('web.settings.remove')}
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          label={t('web.settings.whatsapp')}
          value={info.whatsapp}
          max={20}
          type="tel"
          onChange={(whatsapp) => set({ whatsapp })}
        />
        <TextInput
          label={t('web.settings.phone')}
          value={info.phone}
          max={30}
          type="tel"
          onChange={(phone) => set({ phone })}
        />
        <TextInput
          label={t('web.settings.email')}
          value={info.email}
          max={200}
          type="email"
          onChange={(email) => set({ email })}
        />
        <TextInput
          label={t('web.settings.merchantId')}
          value={info.merchantId}
          max={60}
          onChange={(merchantId) => set({ merchantId })}
        />
      </div>
      <TextArea
        label={t('web.settings.address')}
        value={info.address}
        max={300}
        onChange={(address) => set({ address })}
      />
    </SettingsSection>
  );
}

function SocialSection({ value }: { readonly value: SocialLinks }) {
  const t = useWebsiteT();
  const [links, setLinks] = useState(value);
  const names: readonly (keyof SocialLinks)[] = ['facebook', 'instagram', 'tiktok', 'youtube'];
  const labels: Record<keyof SocialLinks, string> = {
    facebook: t('web.settings.facebook'),
    instagram: t('web.settings.instagram'),
    tiktok: t('web.settings.tiktok'),
    youtube: t('web.settings.youtube'),
  };
  return (
    <SettingsSection title={t('web.settings.social')} patch={() => ({ social: links })}>
      <div className="grid gap-4 sm:grid-cols-2">
        {names.map((name) => (
          <TextInput
            key={name}
            label={labels[name]}
            value={links[name]}
            max={300}
            type="url"
            onChange={(next) => setLinks((current) => ({ ...current, [name]: next }))}
          />
        ))}
      </div>
    </SettingsSection>
  );
}

function AnnouncementSection({ value }: { readonly value: Announcement }) {
  const t = useWebsiteT();
  const [bar, setBar] = useState(value);
  return (
    <SettingsSection
      title={t('web.settings.announcement')}
      patch={() => ({ announcement: bar })}
      disabled={bar.enabled && bar.text.trim() === ''}
    >
      <Toggle
        label={t('web.settings.announcementOn')}
        checked={bar.enabled}
        onChange={(enabled) => setBar((current) => ({ ...current, enabled }))}
      />
      <TextInput
        label={t('web.settings.text')}
        value={bar.text}
        max={200}
        onChange={(text) => setBar((current) => ({ ...current, text }))}
      />
      <TextInput
        label={t('web.settings.link')}
        hint={t('web.settings.linkHelp')}
        value={bar.link}
        max={500}
        onChange={(link) => setBar((current) => ({ ...current, link }))}
      />
    </SettingsSection>
  );
}

function PromoSection({ value }: { readonly value: PromoBanner }) {
  const t = useWebsiteT();
  const [promo, setPromo] = useState(value);
  const field = (key: keyof PromoBanner, labelKey: WebsiteMessageKey, max: number) => (
    <TextInput
      label={t(labelKey)}
      value={String(promo[key])}
      max={max}
      onChange={(next) => setPromo((current) => ({ ...current, [key]: next }))}
    />
  );
  return (
    <SettingsSection
      title={t('web.settings.promo')}
      patch={() => ({ promoBanner: promo })}
      disabled={promo.enabled && promo.headline.trim() === ''}
    >
      <Toggle
        label={t('web.settings.promoOn')}
        checked={promo.enabled}
        onChange={(enabled) => setPromo((current) => ({ ...current, enabled }))}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {field('headline', 'web.settings.headline', 80)}
        {field('decorativeText', 'web.settings.decorativeText', 12)}
      </div>
      <TextArea
        label={t('web.settings.subtext')}
        value={promo.subtext}
        max={300}
        onChange={(subtext) => setPromo((current) => ({ ...current, subtext }))}
      />
      {field('note', 'web.settings.note', 120)}
      <div className="grid gap-4 sm:grid-cols-2">
        {field('primaryLabel', 'web.settings.primaryLabel', 40)}
        {field('primaryHref', 'web.settings.primaryHref', 500)}
        {field('secondaryLabel', 'web.settings.secondaryLabel', 40)}
        {field('secondaryHref', 'web.settings.secondaryHref', 500)}
      </div>
    </SettingsSection>
  );
}

function TestimonialsSection({ value }: { readonly value: readonly Testimonial[] }) {
  const t = useWebsiteT();
  const [items, setItems] = useState<Testimonial[]>([...value]);
  const update = (index: number, patch: Partial<Testimonial>) =>
    setItems((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  const incomplete = items.some((item) => item.name.trim() === '' || item.text.trim() === '');
  return (
    <SettingsSection
      title={t('web.settings.testimonials')}
      patch={() => ({ testimonials: items })}
      disabled={incomplete}
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('web.empty')}</p>
      ) : (
        <ol className="space-y-4">
          {items.map((item, index) => (
            <li key={index} className="space-y-3 rounded-md border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem]">
                <TextInput
                  label={t('web.settings.name')}
                  value={item.name}
                  max={80}
                  onChange={(name) => update(index, { name })}
                />
                <TextInput
                  label={t('web.settings.location')}
                  value={item.location}
                  max={80}
                  onChange={(location) => update(index, { location })}
                />
                <RatingSelect
                  value={item.rating}
                  onChange={(rating) => update(index, { rating })}
                />
              </div>
              <TextArea
                label={t('web.settings.quote')}
                value={item.text}
                max={600}
                onChange={(text) => update(index, { text })}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setItems((current) => current.filter((_, at) => at !== index))}
              >
                <Trash2 aria-hidden />
                {t('web.settings.remove')}
              </Button>
            </li>
          ))}
        </ol>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={items.length >= 20}
        onClick={() =>
          setItems((current) => [...current, { name: '', location: '', rating: 5, text: '' }])
        }
      >
        <Plus aria-hidden />
        {t('web.settings.addTestimonial')}
      </Button>
    </SettingsSection>
  );
}

function RatingSelect({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (next: number) => void;
}) {
  const t = useWebsiteT();
  const id = useId();
  return (
    <Field id={id} label={t('web.settings.rating')}>
      <Select
        id={id}
        value={String(value)}
        onValueChange={(next) => onChange(Number(next))}
        options={[5, 4, 3, 2, 1].map((rating) => ({
          value: String(rating),
          label: String(rating),
        }))}
      />
    </Field>
  );
}

const ZONES = ['inside_dhaka', 'suburbs', 'outside_dhaka'] as const;

function ShippingSection({
  value,
  options,
}: {
  readonly value: ShippingRuleInput;
  readonly options: WebsiteSettings['options'];
}) {
  const t = useWebsiteT();
  const [enabled, setEnabled] = useState(value.freeShippingEnabled);
  const [threshold, setThreshold] = useState(
    value.freeShippingThresholdPoisha === null
      ? ''
      : poishaToTaka(value.freeShippingThresholdPoisha),
  );
  const [fees, setFees] = useState<Record<(typeof ZONES)[number], string>>({
    inside_dhaka: poishaToTaka(value.zones.inside_dhaka.feePoisha),
    suburbs: poishaToTaka(value.zones.suburbs.feePoisha),
    outside_dhaka: poishaToTaka(value.zones.outside_dhaka.feePoisha),
  });
  const [covers, setCovers] = useState<Record<(typeof ZONES)[number], readonly string[]>>({
    inside_dhaka: value.zones.inside_dhaka.deliveryZoneIds,
    suburbs: value.zones.suburbs.deliveryZoneIds,
    outside_dhaka: value.zones.outside_dhaka.deliveryZoneIds,
  });
  // Taka as typed, to integer poisha; a negative or malformed amount is no amount.
  const parse = (text: string): string | null => {
    const value = takaToPoisha(text);
    return value === null || value.startsWith('-') ? null : value;
  };
  const feesValid = ZONES.every((zone) => parse(fees[zone]) !== null);
  const thresholdValid = threshold.trim() === '' || parse(threshold) !== null;
  return (
    <SettingsSection
      title={t('web.settings.shipping')}
      description={t('web.settings.shippingHelp')}
      disabled={!feesValid || !thresholdValid}
      patch={() => ({
        shipping: {
          freeShippingEnabled: enabled,
          freeShippingThresholdPoisha: parse(threshold),
          zones: {
            inside_dhaka: {
              feePoisha: parse(fees.inside_dhaka) ?? '0',
              deliveryZoneIds: [...covers.inside_dhaka],
            },
            suburbs: {
              feePoisha: parse(fees.suburbs) ?? '0',
              deliveryZoneIds: [...covers.suburbs],
            },
            outside_dhaka: {
              feePoisha: parse(fees.outside_dhaka) ?? '0',
              deliveryZoneIds: [...covers.outside_dhaka],
            },
          },
        },
      })}
    >
      <Toggle label={t('web.settings.freeShipping')} checked={enabled} onChange={setEnabled} />
      <TextInput
        label={t('web.settings.threshold')}
        hint={t('web.settings.thresholdHelp')}
        value={threshold}
        max={20}
        onChange={setThreshold}
      />
      <div className="space-y-4">
        {ZONES.map((zone) => (
          <fieldset key={zone} className="space-y-3 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">
              {t(`web.settings.zone.${zone}` as WebsiteMessageKey)}
            </legend>
            <TextInput
              label={t('web.settings.fee')}
              value={fees[zone]}
              max={20}
              onChange={(next) => setFees((current) => ({ ...current, [zone]: next }))}
            />
            <div className="space-y-1.5 text-sm">
              <p className="font-medium">{t('web.settings.covers')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {options.deliveryZones.map((deliveryZone) => (
                  <Toggle
                    key={deliveryZone.id}
                    label={deliveryZone.nameEn}
                    checked={covers[zone].includes(deliveryZone.id)}
                    onChange={(on) =>
                      setCovers((current) => ({
                        ...current,
                        [zone]: on
                          ? [...current[zone], deliveryZone.id]
                          : current[zone].filter((id) => id !== deliveryZone.id),
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          </fieldset>
        ))}
      </div>
    </SettingsSection>
  );
}

function PaymentsSection({ value }: { readonly value: PaymentMethods }) {
  const t = useWebsiteT();
  const [methods, setMethods] = useState(value);
  return (
    <SettingsSection
      title={t('web.settings.payments')}
      patch={() => ({ payments: methods })}
      disabled={!methods.cod && !methods.sslcommerz}
    >
      <Toggle
        label={t('web.settings.cod')}
        checked={methods.cod}
        onChange={(cod) => setMethods((current) => ({ ...current, cod }))}
      />
      <Toggle
        label={t('web.settings.sslcommerz')}
        checked={methods.sslcommerz}
        onChange={(sslcommerz) => setMethods((current) => ({ ...current, sslcommerz }))}
      />
    </SettingsSection>
  );
}

function LocationsSection({
  value,
  options,
}: {
  readonly value: readonly string[];
  readonly options: WebsiteSettings['options'];
}) {
  const t = useWebsiteT();
  const [chosen, setChosen] = useState<readonly string[]>(value);
  const usable = options.locations.filter((location) => location.isActive);
  return (
    <SettingsSection
      title={t('web.settings.locations')}
      description={t('web.settings.locationsHelp')}
      patch={() => ({ webLocationIds: [...chosen] })}
      disabled={chosen.length === 0}
    >
      <div className="space-y-2">
        {usable.map((location) => (
          <Toggle
            key={location.id}
            label={`${location.name} (${location.code})`}
            checked={chosen.includes(location.id)}
            onChange={(on) =>
              setChosen((current) =>
                on ? [...current, location.id] : current.filter((id) => id !== location.id),
              )
            }
          />
        ))}
      </div>
    </SettingsSection>
  );
}
