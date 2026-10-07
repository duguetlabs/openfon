import { COUNTRY_CODES } from '../../../src/countries';
const names = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (code: string) => names.of(code) || code;
const options = COUNTRY_CODES.map(code => ({ code, name: countryName(code) })).sort((a,b)=>a.name.localeCompare(b.name));
/** Uses the ordinary labelled native select; never guesses a business location. */
export function CountrySelect({ value, onChange, disabled }: { value:string|null|undefined; onChange:(value:string|null)=>void; disabled?:boolean }) {
  return <select autoComplete="country" value={value || ''} disabled={disabled} onChange={event=>onChange(event.target.value || null)}>
    <option value="">Not set yet</option>
    {options.map(({code,name})=><option key={code} value={code}>{name}</option>)}
  </select>;
}
