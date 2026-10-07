import { BillingError, type CommercialEnv } from './commercial-dodo';
import { validBusinessCountry } from './countries';

export interface PhoneApproval {
  id:string; revision:number; country:string; number_type:string; area_code:string|null;
}
// Aliases below are source constants, never request input. The database is the
// last admission boundary; a later operator edit cannot retract a sent request.
export const CURRENT_PHONE_APPROVAL = `a.business_id=b.id AND b.country IS NOT NULL
  AND length(trim(b.address))>0 AND a.business_name IS b.name AND a.business_address IS b.address
  AND a.business_country IS b.country AND a.status='approved' AND a.reviewed_at IS NOT NULL
  AND julianday(a.expires_at)>julianday('now')`;
export const QUOTED_PHONE_APPROVAL = `EXISTS(SELECT 1 FROM commercial_phone_approvals a
  JOIN businesses b ON b.id=q.business_id WHERE a.id=q.approval_id AND a.revision=q.approval_revision
  AND ${CURRENT_PHONE_APPROVAL} AND a.country=q.country AND a.number_type=q.number_type
  AND (a.area_code IS NULL OR a.area_code IS q.area_code))`;

export async function approvedPhoneSelection(env:CommercialEnv,businessId:string,country:string,type:string,area:string|null):Promise<PhoneApproval>{
  const approval=await env.DB.prepare(`SELECT a.id,a.revision,a.country,a.number_type,a.area_code
    FROM commercial_phone_approvals a JOIN businesses b ON b.id=a.business_id
    WHERE a.business_id=? AND a.country=? AND a.number_type=? AND (a.area_code IS NULL OR a.area_code IS ?)
    AND ${CURRENT_PHONE_APPROVAL} ORDER BY a.reviewed_at DESC,a.id LIMIT 1`)
    .bind(businessId,country,type,area).first<PhoneApproval>();
  if(!approval)throw new BillingError('Your business needs a current phone-number review for this region. Check your business details and contact support.',409);
  return approval;
}

export async function phoneEligibility(env:CommercialEnv,businessId:string,ready:boolean){
  const business=await env.DB.prepare('SELECT name,address,country FROM businesses WHERE id=?').bind(businessId).first<{name:string;address:string;country:string|null}>();
  const market=validBusinessCountry(env.TELNYX_PURCHASE_COUNTRY)&&env.TELNYX_PURCHASE_COUNTRY?env.TELNYX_PURCHASE_COUNTRY:null;
  const complete=Boolean(business?.country&&validBusinessCountry(business.country)&&business.address.trim());
  const {results}=await env.DB.prepare(`SELECT a.country,a.number_type,a.area_code,a.status,
    CASE WHEN ${CURRENT_PHONE_APPROVAL} THEN 1 ELSE 0 END AS current_approval,
    CASE WHEN a.business_name IS b.name AND a.business_address IS b.address AND a.business_country IS b.country THEN 1 ELSE 0 END AS current_identity
    FROM commercial_phone_approvals a JOIN businesses b ON b.id=a.business_id WHERE a.business_id=? ORDER BY a.reviewed_at DESC,a.id`)
    .bind(businessId).all<any>();
  const offers=market?(['local','toll_free'] as const).flatMap(type=>{
    const rows=results.filter(r=>r.country===market&&r.number_type===type&&r.current_identity===1);
    const approved=rows.filter(r=>r.current_approval===1&&complete);
    if(approved.length)return approved.map(r=>({country:market,type,areaCode:r.area_code,status:'approved',canSearch:ready}));
    return [{country:market,type,areaCode:null,status:complete&&rows.some(r=>r.status==='pending')?'under-review':'requirements-needed',canSearch:false}];
  }):[];
  return {businessCountry:business?.country??null,offers,provisioningAvailable:offers.some(o=>o.canSearch),
    unavailableReason:!complete?'Add your business country and address in My business before requesting a phone number.':!ready?'Phone setup is not available yet. Your existing web call links still work.':!offers.some(o=>o.canSearch)?'Phone requirements have not been approved for this business and region. Contact support to arrange a review.':null};
}
